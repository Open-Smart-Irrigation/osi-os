import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ZoneConfigModal } from '../ZoneConfigModal';
import type { IrrigationZone } from '../../../types/farming';

/**
 * `ZoneConfigModal` had zero `useTranslation` calls and 38 user-visible
 * literals, so the French screen opened with "Configure Zone — Verger Nord"
 * and English field groups over French body copy. Its five `<select>`s were
 * labelled by a sibling `<p>`, which is what axe reported as `select-name`,
 * and latitude/longitude carried a placeholder and no label at all.
 *
 * This is where crop, soil type, area, irrigation efficiency, timezone and
 * coordinates are set — every input to the water balance.
 */

vi.mock('../../../services/deviceLocation', () => ({
  getDeviceLocationErrorMessage: vi.fn(() => 'Location unavailable'),
  getDeviceLocationSupport: vi.fn().mockResolvedValue({
    available: false,
    reason: 'unsupported',
    message: 'Device GPS unavailable in tests',
    permissionState: 'unknown',
    canOpenSettings: false,
  }),
  openNativeLocationSettings: vi.fn(() => false),
  requestDeviceLocation: vi.fn(),
}));

vi.mock('../../../services/api', () => ({
  irrigationZonesAPI: {
    updateConfig: vi.fn().mockResolvedValue({}),
    updateCalibration: vi.fn().mockResolvedValue(undefined),
    setZoneLocation: vi.fn().mockResolvedValue(undefined),
  },
  zoneExportAPI: { download: vi.fn().mockResolvedValue(undefined) },
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

const zone: IrrigationZone = {
  id: 42,
  name: 'Verger Nord',
  device_count: 0,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  schedule: null,
  measuredFlowRateLpm: null,
  measurementMethod: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('zone configuration modal', () => {
  it('gives every control a label a screen reader can read', async () => {
    render(<ZoneConfigModal isOpen zone={zone} onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('heading', { name: /Verger Nord/ })).toBeInTheDocument());

    for (const label of [
      'Crop',
      'Variety',
      'Soil type',
      'Irrigation method',
      'Area (m²)',
      'Irrigation efficiency (%)',
      'Flow rate (L/min)',
      'Measurement method',
      'Dendro calibration',
      'Phenological stage',
      'Timezone',
      'Latitude',
      'Longitude',
      'Notes',
    ]) {
      expect(screen.getByLabelText(label), `${label} has no associated control`).toBeInTheDocument();
    }
  });

  it('routes its title and option lists through t()', async () => {
    render(<ZoneConfigModal isOpen zone={zone} onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Configure zone — Verger Nord' })).toBeInTheDocument());

    expect(screen.getByRole('option', { name: '— Select soil type —' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Sandy loam' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Drip / micro-drip' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Bud break / flowering' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Grapevine' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });
});
