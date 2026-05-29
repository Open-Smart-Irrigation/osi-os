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
});
