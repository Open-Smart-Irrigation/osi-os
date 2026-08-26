import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Device } from '../../../types/farming';
import { devicesAPI } from '../../../services/api';
import { Sdi12SoilCard } from '../Sdi12SoilCard';

// t() returns the key itself, matching this codebase's convention.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../../services/api', () => ({
  devicesAPI: { remove: vi.fn().mockResolvedValue(undefined) },
}));

const baseDevice: Device = {
  deveui: '70B3D5E75E004202',
  name: 'SDI-12 row 3',
  type_id: 'DRAGINO_SDI12',
  latest_data: {},
};

function makeDevice(
  overrides: Partial<Device> & { latest?: Device['latest_data'] } = {},
): Device {
  const { latest, ...deviceOverrides } = overrides;
  return {
    ...baseDevice,
    ...deviceOverrides,
    latest_data: latest ?? baseDevice.latest_data,
  };
}

describe('Sdi12SoilCard', () => {
  it('renders populated vwc depths with labels and status chip', () => {
    render(<Sdi12SoilCard device={makeDevice({
      sdi12_probe_profile: 'SENTEK_ENVIROSCAN',
      sdi12_probe_status: 'identified',
      soil_moisture_probe_depths_json: { vwc_1: 10, vwc_2: 20 },
      latest: { vwc_1: 30.5, vwc_2: 28.1, bat_v: 3.3 },
    })} />);

    expect(screen.getByText(/30\.5/)).toBeInTheDocument();
    expect(screen.getByText(/10\s*cm/)).toBeInTheDocument();
    expect(screen.getByText(/identified/i)).toBeInTheDocument();
    expect(screen.queryByText(/µS\/cm/)).not.toBeInTheDocument();
  });

  it('sorts configured modules by depth and shows VWC with adjacent VIC or missing markers', () => {
    render(<Sdi12SoilCard device={makeDevice({
      sdi12_probe_profile: 'SENTEK_ENVIROSCAN',
      sdi12_channel_layout_json: { version: 1, address: 'L', sensors: [
        { channel: 7, response_position: 2, depth_cm: 80, type: 'ENVIROSCAN' },
        { channel: 9, response_position: 1, depth_cm: 70, type: 'TRISCAN' },
      ] },
      latest: { vwc_9: 22.5, soil_vic_9: 0.125 },
    })} />);
    const depths = screen.getAllByText(/Depth \d+ cm/).map((node) => node.textContent);
    expect(depths).toEqual(['Depth 70 cm', 'Depth 80 cm']);
    expect(screen.getByText('22.5 %')).toBeInTheDocument();
    expect(screen.getByText('0.125')).toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(1);
    expect(screen.getByText(/TriSCAN VIC acquisition is disabled/)).toBeInTheDocument();
  });

  it('surfaces an invalid stored Sentek layout status', () => {
    render(<Sdi12SoilCard device={makeDevice({
      sdi12_probe_profile: 'SENTEK_ENVIROSCAN',
      sdi12_layout_status: 'invalid',
    })} />);
    expect(screen.getByText(/saved Sentek channel layout is invalid/)).toBeInTheDocument();
  });

  it('shows pending state when unidentified', () => {
    render(<Sdi12SoilCard device={makeDevice({
      sdi12_probe_status: 'pending_identify',
      latest: { bat_v: 3.3 },
    })} />);

    expect(screen.getByText(/detecting probe|pending/i)).toBeInTheDocument();
  });

  it('renders the status chip from the device status field', () => {
    render(<Sdi12SoilCard device={makeDevice({
      sdi12_probe_status: 'unmatched',
    })} />);

    expect(screen.getByText('unmatched')).toBeInTheDocument();
  });

  it('shows the client-derived no-response state once pending_identify has aged past the timeout', () => {
    const stale = new Date(Date.now() - 16 * 60000).toISOString();
    render(<Sdi12SoilCard device={makeDevice({
      sdi12_probe_status: 'pending_identify',
      updated_at: stale,
      latest: { bat_v: 3.3 },
    })} />);

    expect(screen.getByText('sdi12.noResponse')).toBeInTheDocument();
    expect(screen.queryByText(/detecting probe/i)).not.toBeInTheDocument();
  });

  it('removes the device when the operator confirms', async () => {
    const onRemove = vi.fn();
    vi.mocked(devicesAPI.remove).mockResolvedValueOnce(undefined as never);
    const device = makeDevice();
    render(<Sdi12SoilCard device={device} onRemove={onRemove} />);

    fireEvent.click(screen.getByTitle('Remove device'));
    fireEvent.click(screen.getByText('sdi12Soil.yesRemove'));

    await waitFor(() => expect(devicesAPI.remove).toHaveBeenCalledWith(device.deveui));
    await waitFor(() => expect(onRemove).toHaveBeenCalled());
  });

  it('does not render a remove button in readOnly mode', () => {
    render(<Sdi12SoilCard device={makeDevice()} readOnly />);
    expect(screen.queryByTitle('Remove device')).not.toBeInTheDocument();
  });
});
