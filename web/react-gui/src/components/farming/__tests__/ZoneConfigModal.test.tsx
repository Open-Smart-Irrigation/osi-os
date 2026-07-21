import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

import { ZoneConfigModal } from '../ZoneConfigModal';
import { irrigationZonesAPI } from '../../../services/api';
import type { IrrigationZone } from '../../../types/farming';

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
  zoneExportAPI: {
    download: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => {
      if (key === 'zone.export.title') return 'Export data';
      if (key === 'zone.export.rangeSummary') return `${params?.from ?? ''} to ${params?.to ?? ''}`;
      return key;
    },
  }),
}));

const zone: IrrigationZone = {
  id: 42,
  name: 'North Block',
  device_count: 0,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  schedule: null,
  measuredFlowRateLpm: null,
  measurementMethod: null,
};

describe('ZoneConfigModal irrigation calibration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the data export range calendar for an existing zone', async () => {
    render(
      React.createElement(ZoneConfigModal, {
        isOpen: true,
        zone,
        onClose: vi.fn(),
        onSaved: vi.fn(),
      }),
    );

    expect(await screen.findByText('Export data')).toBeInTheDocument();
    expect(screen.getByTestId('range-calendar')).toBeInTheDocument();
  });

  it('saves flow rate and measurement method through the calibration endpoint', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(
      React.createElement(ZoneConfigModal, {
        isOpen: true,
        zone,
        onClose,
        onSaved,
      }),
    );

    fireEvent.change(screen.getByPlaceholderText('L/min'), { target: { value: '12.5' } });
    fireEvent.change(screen.getByPlaceholderText('Bucket test, meter read, or other method'), {
      target: { value: 'Timed bucket test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(irrigationZonesAPI.updateCalibration).toHaveBeenCalledWith(42, {
        measuredFlowRateLpm: 12.5,
        measurementMethod: 'Timed bucket test',
      });
    });
    expect(onSaved).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('does not expose retired prediction advisory or scheduling source controls', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(
      React.createElement(ZoneConfigModal, {
        isOpen: true,
        zone: {
          ...zone,
          schedulingMode: 'server_preferred',
          predictionCardEnabled: true,
        },
        onClose,
        onSaved,
      }),
    );

    expect(await screen.findByText('Export data')).toBeInTheDocument();
    expect(screen.queryByText('Prediction Advisory')).not.toBeInTheDocument();
    expect(screen.queryByText('Scheduling source')).not.toBeInTheDocument();
    expect(screen.queryByText('Used to convert irrigation liters into effective mm for the water balance.')).not.toBeInTheDocument();
    expect(screen.queryByText('Enter the estimated share of delivered water that reaches the crop root zone.')).not.toBeInTheDocument();
    expect(screen.queryByText('Used to align nightly min/max extraction windows. IANA timezone (e.g. Europe/Rome).')).not.toBeInTheDocument();
    expect(screen.queryByText('Selects species-specific stress thresholds for dendrometer analysis.')).not.toBeInTheDocument();
    expect(screen.queryByText('Adjusts stress sensitivity for the current growth phase.')).not.toBeInTheDocument();
    expect(screen.queryByText('Used for weather and VPD lookup. Save both coordinates together.')).not.toBeInTheDocument();
    expect(screen.queryByText('Use your phone or browser location for this zone.')).not.toBeInTheDocument();
    expect(screen.queryByText('Fills latitude and longitude from this device. Review timezone separately if the farm is in a different timezone.')).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Any additional info about this zone…'), {
      target: { value: 'Use local schedule defaults.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledWith(42, {
        notes: 'Use local schedule defaults.',
      });
    });
  });
});
