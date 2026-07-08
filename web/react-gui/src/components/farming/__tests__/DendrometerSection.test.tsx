import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DendrometerSection } from '../dendrometer/DendrometerSection';
import type { Device, IrrigationZone, ZoneRecommendation } from '../../../types/farming';

const apiMocks = vi.hoisted(() => ({
  getDailyIndicators: vi.fn(),
  getZoneRecommendations: vi.fn(),
}));

vi.mock('../../../services/api', () => ({
  dendroAnalyticsAPI: {
    getDailyIndicators: apiMocks.getDailyIndicators,
    getZoneRecommendations: apiMocks.getZoneRecommendations,
  },
}));

vi.mock('../dendrometer/DendrometerTreeCard', () => ({
  DendrometerTreeCard: () => <div data-testid="dendrometer-tree-card" />,
}));

vi.mock('../dendrometer/ZoneAnalysisCard', () => ({
  ZoneAnalysisCard: () => <div data-testid="zone-analysis-card" />,
}));

vi.mock('../dendrometer/DendrometerMonitor', () => ({
  DendrometerMonitor: () => <div data-testid="dendrometer-monitor" />,
}));

const zone = {
  id: 12,
  name: 'Zone B',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
} as IrrigationZone;

const dendroDevice = {
  deveui: 'A84041A75D5E7CFB',
  name: 'Dendro 1',
  type_id: 'DRAGINO_LSN50',
  dendro_enabled: 1,
  latest_data: {},
} as Device;

const recommendation = {
  id: 7,
  zone_id: 12,
  date: '2026-07-08',
  zone_stress_summary: 'mild',
  rainfall_mm: 0,
  water_delivered_liters: 0,
  irrigation_action: 'maintain',
  action_reasoning: 'Dendrometer trend is stable.',
  recommendation_json: null,
  diagnostics: null,
  computed_at: '2026-07-08T08:00:00.000Z',
  rain_suppression_active: 0,
  recovery_verification_active: 0,
  vpd_max_kpa: null,
  vpd_source: null,
  usable_tree_count: 1,
  low_confidence_tree_count: 0,
  outlier_filtered_tree_count: 0,
  zone_confidence_score: 0.86,
} satisfies ZoneRecommendation;

beforeEach(() => {
  apiMocks.getDailyIndicators.mockReset();
  apiMocks.getDailyIndicators.mockResolvedValue([]);
  apiMocks.getZoneRecommendations.mockReset();
  apiMocks.getZoneRecommendations.mockResolvedValue([recommendation]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DendrometerSection prediction advisory', () => {
  it('shows the irrigation advisory banner when prediction advisory is enabled', async () => {
    render(
      <DendrometerSection
        zone={zone}
        devices={[dendroDevice]}
        predictionAdvisoryEnabled
      />,
    );

    expect(await screen.findByText('Maintain current irrigation')).toBeVisible();
    expect(screen.getByText('Dendrometer trend is stable.')).toBeVisible();
  });

  it('does not fetch or show the advisory banner when prediction advisory is disabled', async () => {
    render(
      <DendrometerSection
        zone={zone}
        devices={[dendroDevice]}
        predictionAdvisoryEnabled={false}
      />,
    );

    expect(await screen.findByText('Dendrometer Monitoring')).toBeVisible();
    expect(apiMocks.getZoneRecommendations).not.toHaveBeenCalled();
    expect(screen.queryByText('Maintain current irrigation')).not.toBeInTheDocument();
  });
});
