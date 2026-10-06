import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Device } from '../../../types/farming';
import { devicesAPI } from '../../../services/api';
import { Sdi12SoilCard } from '../Sdi12SoilCard';

const STATUS_LABELS: Record<string, string> = {
  'history.soil.state.wet': 'Wet',
  'history.soil.state.moist': 'Moist',
  'history.soil.state.dry': 'Dry',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => STATUS_LABELS[key] ?? key }),
}));

const NOW = Date.parse('2026-09-24T08:00:00.000Z');
const FRESH = new Date(NOW - 30 * 60 * 1000).toISOString();
const STALE = new Date(NOW - 4 * 60 * 60 * 1000).toISOString();
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  window.localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

vi.mock('../../../services/api', () => ({
  sensorAPI: { getHistory: vi.fn().mockResolvedValue([]) },
  devicesAPI: {
    remove: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue({
      deveui: '70B3D5E75E004202',
      name: 'Row 4',
      sync_version: 2,
      changed: true,
      chirpstack: 'updated',
    }),
  },
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
    render(<Sdi12SoilCard removeContext="farm" device={makeDevice({
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
    render(<Sdi12SoilCard removeContext="farm" device={makeDevice({
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
    expect(screen.queryByText(/TriSCAN VIC acquisition is disabled/)).not.toBeInTheDocument();
  });

  it('surfaces an invalid stored Sentek layout status', () => {
    render(<Sdi12SoilCard removeContext="farm" device={makeDevice({
      sdi12_probe_profile: 'SENTEK_ENVIROSCAN',
      sdi12_layout_status: 'invalid',
    })} />);
    expect(screen.getByText(/saved Sentek channel layout is invalid/)).toBeInTheDocument();
  });

  it('shows commissioning state without hiding old readings and labels only compatible deployment as active', () => {
    render(<Sdi12SoilCard removeContext="farm" device={makeDevice({
      sdi12_probe_profile: 'SENTEK_ENVIROSCAN',
      sdi12_channel_layout_json: { version: 1, address: '7', sensors: [{ channel: 1, response_position: 1, depth_cm: 10, type: 'TRISCAN' }] },
      sdi12_recipe_deployment: { desired_version: 2, desired_layout_hash: 'abc', status: 'observed_compatible', queued_at: null, queue_drained_at: null, commissioning_deadline_at: null, last_observed_at: null, compatible_at: null, updated_at: null, frame_count: 1, compatible_available: true, last_error_code: null },
      latest: { vwc_1: 0, soil_vic_1: 0 },
    })} />);
    expect(screen.getByText('sdi12.active')).toBeInTheDocument();
    expect(screen.getByText('0.0 %')).toBeInTheDocument();
    expect(screen.getByText('0.000')).toBeInTheDocument();
  });

  it('shows pending state when unidentified', () => {
    render(<Sdi12SoilCard removeContext="farm" device={makeDevice({
      sdi12_probe_status: 'pending_identify',
      latest: { bat_v: 3.3 },
    })} />);

    expect(screen.getByText(/detecting probe|pending/i)).toBeInTheDocument();
  });

  it('renders the status chip from the device status field', () => {
    render(<Sdi12SoilCard removeContext="farm" device={makeDevice({
      sdi12_probe_status: 'unmatched',
    })} />);

    expect(screen.getByText('unmatched')).toBeInTheDocument();
  });

  it('shows the client-derived no-response state once pending_identify has aged past the timeout', () => {
    const stale = new Date(Date.now() - 16 * 60000).toISOString();
    render(<Sdi12SoilCard removeContext="farm" device={makeDevice({
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
    render(<Sdi12SoilCard device={device} onRemove={onRemove} removeContext="farm" />);

    fireEvent.click(screen.getByTitle('deviceRemoval.buttonFarm'));
    fireEvent.click(screen.getByText('deviceRemoval.confirmFarm'));

    await waitFor(() => expect(devicesAPI.remove).toHaveBeenCalledWith(device.deveui));
    await waitFor(() => expect(onRemove).toHaveBeenCalled());
  });

  it('does not render a remove button in readOnly mode', () => {
    render(<Sdi12SoilCard device={makeDevice()} readOnly removeContext="farm" />);
    expect(screen.queryByTitle('deviceRemoval.buttonFarm')).not.toBeInTheDocument();
  });

  it('renames the device through the device route and refreshes', async () => {
    const onUpdate = vi.fn();
    render(<Sdi12SoilCard device={makeDevice()} onUpdate={onUpdate} removeContext="farm" />);

    fireEvent.click(screen.getByTitle('rename.device'));
    const input = screen.getByLabelText('rename.deviceInputLabel');
    fireEvent.change(input, { target: { value: 'Row 4' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(devicesAPI.rename).toHaveBeenCalledWith('70B3D5E75E004202', 'Row 4'));
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
  });

  it('does not offer a rename in readOnly mode', () => {
    render(<Sdi12SoilCard device={makeDevice()} readOnly removeContext="farm" />);
    expect(screen.queryByTitle('rename.device')).not.toBeInTheDocument();
  });
  it('adds VIA status only to current SDI-12 SWT rows', () => {
    render(<Sdi12SoilCard removeContext="farm" device={makeDevice({
      sdi12_probe_profile: 'TENSIOMARK',
      last_seen: FRESH,
      latest: { swt_1: 30.2, soil_temp_1: 21.5 },
    })} />);
    expect(screen.getByText('30.2 kPa · 2.48 pF')).toBeInTheDocument();
    expect(screen.getByText('Moist')).toBeInTheDocument();
    expect(screen.getAllByText(/Soil temperature/)).toHaveLength(1);
  });

  it('withholds stale and out-of-range SDI-12 status without hiding the row', () => {
    const { rerender } = render(<Sdi12SoilCard removeContext="farm" device={makeDevice({
      sdi12_probe_profile: 'TENSIOMARK',
      last_seen: STALE,
      latest: { swt_1: 30.2 },
    })} />);
    expect(screen.queryByText('Moist')).not.toBeInTheDocument();

    rerender(<Sdi12SoilCard removeContext="farm" device={makeDevice({
      sdi12_probe_profile: 'TENSIOMARK',
      last_seen: FRESH,
      latest: { swt_1: 301 },
    })} />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('Dry')).not.toBeInTheDocument();
  });

  // Before the pF floor rule a zero showed kPa only, without its pF.
  it('renders zero as kPa with the 0 pF floor and marks it Wet', () => {
    window.localStorage.setItem('osi.display.swtUnit', 'pF');
    render(<Sdi12SoilCard removeContext="farm" device={makeDevice({
      sdi12_probe_profile: 'TENSIOMARK',
      last_seen: FRESH,
      latest: { swt_1: 0 },
    })} />);
    expect(screen.getByText('0.0 kPa · 0.00 pF')).toBeInTheDocument();
    expect(screen.getByText('Wet')).toBeInTheDocument();
  });

  it('never shows a negative pF for tension between 0 and 0.1 kPa', () => {
    render(<Sdi12SoilCard removeContext="farm" device={makeDevice({
      sdi12_probe_profile: 'TENSIOMARK',
      last_seen: FRESH,
      latest: { swt_1: 0.05 },
    })} />);
    expect(screen.getByText('0.1 kPa · 0.00 pF')).toBeInTheDocument();
    expect(screen.queryByText(/-0\.30 pF/)).not.toBeInTheDocument();
  });

});

describe('Sdi12SoilCard history', () => {
  async function historyMock() {
    const { sensorAPI } = await import('../../../services/api');
    vi.mocked(sensorAPI.getHistory).mockClear();
    return sensorAPI.getHistory;
  }

  const layoutDevice = makeDevice({
    deveui: 'A840410000000001',
    sdi12_probe_profile: 'SENTEK_ENVIROSCAN',
    sdi12_channel_layout_json: { version: 1, address: 'L', sensors: [
      { channel: 7, response_position: 2, depth_cm: 80, type: 'ENVIROSCAN' },
      { channel: 9, response_position: 1, depth_cm: 70, type: 'TRISCAN' },
    ] },
    latest: { vwc_9: 22.5, soil_vic_9: 0.125 },
  });

  it('opens the legacy history view for a VWC value with the depth series', async () => {
    const getHistory = await historyMock();
    render(<Sdi12SoilCard removeContext="farm" device={layoutDevice} />);
    const control = screen.getByRole('button', { name: 'VWC, 70 cm: 22.5 %' });
    expect(control).toHaveAttribute('title', 'common.viewHistory');
    expect(control.className).toContain('focus-visible:ring-2');
    fireEvent.click(control);
    expect(await screen.findByRole('dialog', { name: 'VWC · 70 cm' })).toBeInTheDocument();
    await waitFor(() => expect(getHistory).toHaveBeenCalledWith('A840410000000001', 'vwc_9', 24));
    // The other quantity at the same depth is one switch away.
    fireEvent.click(screen.getByRole('button', { name: 'VIC · 70 cm' }));
    await waitFor(() => expect(getHistory).toHaveBeenCalledWith('A840410000000001', 'soil_vic_9', 24));
  });

  it('opens the second quantity (VIC) directly', async () => {
    const getHistory = await historyMock();
    render(<Sdi12SoilCard removeContext="farm" device={layoutDevice} />);
    fireEvent.click(screen.getByRole('button', { name: 'VIC, 70 cm: 0.125' }));
    await waitFor(() => expect(getHistory).toHaveBeenCalledWith('A840410000000001', 'soil_vic_9', 24));
  });

  it('titles a unitless series without empty unit brackets', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const getHistory = await historyMock();
    vi.mocked(getHistory).mockResolvedValue([{ t: '2026-09-24T07:00:00.000Z', value: 0.12 }] as never);
    render(<Sdi12SoilCard removeContext="farm" device={layoutDevice} />);
    fireEvent.click(screen.getByRole('button', { name: 'VIC, 70 cm: 0.125' }));
    expect(await screen.findByRole('heading', { name: 'VIC · 70 cm', level: 3 })).toBeInTheDocument();
    expect(screen.queryByText(/\(\)/)).not.toBeInTheDocument();
    vi.mocked(getHistory).mockResolvedValue([] as never);
    vi.unstubAllGlobals();
  });

  it('keeps a missing value plain text', () => {
    render(<Sdi12SoilCard removeContext="farm" device={layoutDevice} />);
    expect(screen.getAllByTitle('common.viewHistory')).toHaveLength(2);
    expect(screen.getByText('—').closest('button')).toBeNull();
  });

  it('opens temperature, EC and SWT series per depth', async () => {
    const getHistory = await historyMock();
    render(<Sdi12SoilCard removeContext="farm" device={makeDevice({
      deveui: 'A840410000000001',
      sdi12_probe_profile: 'TENSIOMARK',
      soil_moisture_probe_depths_json: { swt_2: 30 },
      latest: { swt_2: 30.2, soil_temp_2: 21.5, soil_ec_2: 410 },
    })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Soil temperature, 30 cm: 21.5 °C' }));
    await waitFor(() => expect(getHistory).toHaveBeenLastCalledWith('A840410000000001', 'soil_temp_2', 24));
    fireEvent.click(screen.getByRole('button', { name: 'Soil EC · 30 cm' }));
    await waitFor(() => expect(getHistory).toHaveBeenLastCalledWith('A840410000000001', 'soil_ec_2', 24));
    fireEvent.click(screen.getByRole('button', { name: 'SWT · 30 cm' }));
    await waitFor(() => expect(getHistory).toHaveBeenLastCalledWith('A840410000000001', 'swt_2', 24));
  });

  it('offers no history for a key the gateway does not serve', () => {
    render(<Sdi12SoilCard removeContext="farm" device={makeDevice({
      sdi12_probe_profile: 'TENSIOMARK',
      latest: { soil_temp_9: 18.5, vwc_9: 20.1 } as Device['latest_data'],
    })} />);
    expect(screen.getByText('18.5 °C').closest('button')).toBeNull();
    expect(screen.getByText('20.1 %').closest('button')).not.toBeNull();
  });
});
