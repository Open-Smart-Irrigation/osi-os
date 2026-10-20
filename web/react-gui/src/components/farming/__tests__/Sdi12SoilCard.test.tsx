import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Device } from '../../../types/farming';
import { devicesAPI } from '../../../services/api';
import { Sdi12SoilCard } from '../Sdi12SoilCard';
import { writeDisplayPreferences } from '../../../utils/displayPreferences';

const STATUS_LABELS: Record<string, string> = {
  'history.soil.state.wet': 'Wet',
  'history.soil.state.moist': 'Moist',
  'history.soil.state.dry': 'Dry',
  'soilTension.sectionTitle': 'Soil tension',
  'soilTension.channel': 'Soil tension {{channel}}',
  'soilTension.depthCm': '({{depth}} cm)',
  'soilTension.soilTemp': 'Soil {{value}} °C',
  'soilTension.soilTempSeries': 'Soil temperature {{channel}}',
  'soilTension.invalidReading': 'Invalid reading',
  'soilTension.noReadings': 'No soil readings available.',
  'sdi12Soil.detecting': 'Detecting probe (pending)',
  'sdi12Soil.invalidLayout': 'The saved Sentek channel layout is invalid. Open device settings and save a valid layout before relying on soil readings.',
  'sdi12Soil.status.unmatched': 'Not recognised',
  'sdi12Soil.status.pending_identify': 'Identifying',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => (STATUS_LABELS[key] ?? key)
      .replace(/{{(\w+)}}/g, (_, name: string) => String(values?.[name] ?? `{{${name}}}`)),
  }),
}));

const NOW = Date.parse('2026-09-24T08:00:00.000Z');
const FRESH = new Date(NOW - 30 * 60 * 1000).toISOString();
const DAYS_OLD = new Date(NOW - 5 * 24 * 60 * 60 * 1000).toISOString();
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

    expect(screen.getByText('Detecting probe (pending)')).toBeInTheDocument();
    expect(screen.getByText('Identifying')).toBeInTheDocument();
  });

  it('renders the status chip from the device status field', () => {
    render(<Sdi12SoilCard removeContext="farm" device={makeDevice({
      sdi12_probe_status: 'unmatched',
    })} />);

    expect(screen.getByText('Not recognised')).toBeInTheDocument();
    expect(screen.queryByText('unmatched')).not.toBeInTheDocument();
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
    expect(screen.getByText('30.2 kPa')).toBeInTheDocument();
    expect(screen.getByText('Moist')).toBeInTheDocument();
    expect(screen.getAllByText('Soil 21.5 °C')).toHaveLength(1);
  });

  it('renders each Tensiomark probe as a soil tension tile with its temperature and honest null depth', () => {
    render(<Sdi12SoilCard removeContext="farm" device={makeDevice({
      deveui: 'A840410000000207',
      sdi12_probe_profile: 'TENSIOMARK',
      last_seen: FRESH,
      sdi12_channel_layout_json: {
        version: 1, kind: 'tensiomark', source_unit: 'pF', field_order: 'temperature_pf', qualification: 'bench_observed',
        sensors: [
          { address: '1', channel: 1, identity: '111TENSIOMARK_2Vh_10A00001', depth_cm: null, calibration_range: 'unverified' },
          { address: '4', channel: 2, identity: '411TENSIOMARK_2Vh_10A00002', depth_cm: 40, calibration_range: 'unverified' },
        ],
      },
      latest: { swt_1: 1000, soil_temp_1: 16.1, swt_2: 0.1, soil_temp_2: 18.25, bat_v: 3.606 },
    })} />);

    // The probe of known depth comes first; the unknown depth goes last.
    expect(screen.getAllByTestId('soil-tension-tile').map((tile) => tile.querySelector('p')?.textContent))
      .toEqual(['Soil tension 2 (40 cm)', 'Soil tension 1']);
    expect(within(screen.getByRole('group', { name: 'Soil tension 1' })).getByRole('button', { name: '1000.0 kPa' })).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Soil tension 2 (40 cm)' })).getByRole('button', { name: '0.1 kPa' })).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Soil tension 2 (40 cm)' })).getByRole('button', { name: 'Soil 18.3 °C' })).toBeInTheDocument();
    expect(screen.queryByText(/Address/)).not.toBeInTheDocument();
  });

  it('uses the common water-state badge for an explicit Tensiomark layout', () => {
    render(<Sdi12SoilCard removeContext="farm" device={makeDevice({
      sdi12_probe_profile: 'TENSIOMARK',
      last_seen: FRESH,
      sdi12_channel_layout_json: {
        version: 1, kind: 'tensiomark', source_unit: 'pF', field_order: 'temperature_pf', qualification: 'bench_observed',
        sensors: [
          { address: '1', channel: 1, identity: '111TENSIOMARK_2Vh_10A00001', depth_cm: null, calibration_range: 'unverified' },
          { address: '4', channel: 2, identity: '411TENSIOMARK_2Vh_10A00002', depth_cm: null, calibration_range: 'unverified' },
        ],
      },
      latest: { swt_1: 30.2, soil_temp_1: 21.5, bat_v: 3.6 },
    })} />);

    expect(screen.queryByText('sdi12.tensiomark.calibrationRange')).not.toBeInTheDocument();
    expect(screen.getByText('30.2 kPa')).toBeInTheDocument();
    expect(screen.getByText('Moist')).toBeInTheDocument();
  });

  it('keeps missing readings unavailable when the explicit Tensiomark layout has no accepted reading', () => {
    render(<Sdi12SoilCard removeContext="farm" device={makeDevice({
      sdi12_probe_profile: 'TENSIOMARK',
      sdi12_channel_layout_json: {
        version: 1, kind: 'tensiomark', source_unit: 'pF', field_order: 'temperature_pf', qualification: 'bench_observed',
        sensors: [
          { address: '1', channel: 1, identity: '111TENSIOMARK_2Vh_10A00001', depth_cm: null, calibration_range: 'unverified' },
          { address: '4', channel: 2, identity: '411TENSIOMARK_2Vh_10A00002', depth_cm: null, calibration_range: 'unverified' },
        ],
      },
      latest: { bat_v: 3.6 },
    })} />);

    expect(screen.queryByText('sdi12.tensiomark.calibrationRange')).not.toBeInTheDocument();
    // One dash per probe; a missing soil temperature leaves no line.
    expect(screen.getAllByText('—')).toHaveLength(2);
    expect(screen.queryByText(/°C/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Wet|Moist|Dry/)).not.toBeInTheDocument();
  });

  it.each([
    [0, '0.0 kPa'],
    [0.1, '0.1 kPa'],
    [1000, '1000.0 kPa'],
    [1000000, '1000000.0 kPa'],
  ])('displays the qualified Tensiomark range endpoint %s with the common SWT status', (value, label) => {
    render(<Sdi12SoilCard removeContext="farm" device={makeDevice({
      sdi12_probe_profile: 'TENSIOMARK',
      last_seen: FRESH,
      latest: { swt_1: value },
    })} />);

    expect(screen.getByText(label)).toBeInTheDocument();
    if (value > 300) expect(screen.getByText('Dry')).toBeInTheDocument();
  });

  it.each([-1, 1000000.1])('withholds out-of-range Tensiomark value %s and its status', (value) => {
    render(<Sdi12SoilCard removeContext="farm" device={makeDevice({
      sdi12_probe_profile: 'TENSIOMARK',
      last_seen: FRESH,
      latest: { swt_1: value },
    })} />);

    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText(/Wet|Moist|Dry/)).not.toBeInTheDocument();
  });

  it.each([null, Number.NaN, Number.POSITIVE_INFINITY])('treats missing or non-finite Tensiomark value %s as unavailable', (value) => {
    render(<Sdi12SoilCard removeContext="farm" device={makeDevice({
      sdi12_probe_profile: 'TENSIOMARK',
      last_seen: FRESH,
      latest: { swt_1: value },
    })} />);

    expect(screen.getByText('No soil readings available.')).toBeInTheDocument();
    expect(screen.queryByText(/Wet|Moist|Dry/)).not.toBeInTheDocument();
  });

  it('keeps the status on a qualified Tensiomark reading days old', () => {
    const { rerender } = render(<Sdi12SoilCard removeContext="farm" device={makeDevice({
      sdi12_probe_profile: 'TENSIOMARK',
      last_seen: DAYS_OLD,
      latest: { swt_1: 30.2 },
    })} />);
    expect(screen.getByText('Moist')).toBeInTheDocument();

    rerender(<Sdi12SoilCard removeContext="farm" device={makeDevice({
      sdi12_probe_profile: 'TENSIOMARK',
      last_seen: DAYS_OLD,
      latest: { swt_1: 1000 },
    })} />);
    expect(screen.getByText('1000.0 kPa')).toBeInTheDocument();
    expect(screen.getByText('Dry')).toBeInTheDocument();
  });

  it('uses the same range and measured zero for other profiles', () => {
    const { rerender } = render(<Sdi12SoilCard removeContext="farm" device={makeDevice({
      sdi12_probe_profile: 'SENTEK_ENVIROSCAN',
      last_seen: FRESH,
      latest: { swt_1: 301 },
    })} />);
    expect(screen.getByText('301.0 kPa')).toBeInTheDocument();
    expect(screen.getByText('Dry')).toBeInTheDocument();

    rerender(<Sdi12SoilCard removeContext="farm" device={makeDevice({
      sdi12_probe_profile: 'SENTEK_ENVIROSCAN',
      last_seen: FRESH,
      latest: { swt_1: 0 },
    })} />);
    expect(screen.getAllByText('0.0 kPa')).toHaveLength(1);
    expect(screen.getByText('Wet')).toBeInTheDocument();
  });

  it('shows a measured zero as 0.0 kPa in pF mode next to its Wet status', () => {
    window.localStorage.setItem('osi.display.swtUnit', 'pF');
    render(<Sdi12SoilCard removeContext="farm" device={makeDevice({
      sdi12_probe_profile: 'TENSIOMARK', last_seen: FRESH, latest: { swt_1: 0 },
    })} />);
    expect(screen.getByText('0.0 kPa')).toBeInTheDocument();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
    expect(screen.getByText('Wet')).toBeInTheDocument();
  });

  it('shows negative pF for tension below 0.1 kPa', () => {
    window.localStorage.setItem('osi.display.swtUnit', 'pF');
    render(<Sdi12SoilCard removeContext="farm" device={makeDevice({
      sdi12_probe_profile: 'SENTEK_ENVIROSCAN',
      last_seen: FRESH,
      latest: { swt_1: 0.05 },
    })} />);
    expect(screen.getByText('-0.30 pF')).toBeInTheDocument();
  });

  it('switches both mounted Tensiomark probes to pF without changing temperature or depth context', () => {
    render(<Sdi12SoilCard removeContext='farm' device={makeDevice({
      sdi12_probe_profile: 'TENSIOMARK',
      sdi12_channel_layout_json: {
        version: 1, kind: 'tensiomark', source_unit: 'pF', field_order: 'temperature_pf', qualification: 'bench_observed',
        sensors: [
          { address: '1', channel: 1, identity: '111TENSIOMARK_2Vh_10A00001', depth_cm: null, calibration_range: 'unverified' },
          { address: '4', channel: 2, identity: '411TENSIOMARK_2Vh_10A00002', depth_cm: null, calibration_range: 'unverified' },
        ],
      },
      latest: { swt_1: 1.97, soil_temp_1: 13.96, swt_2: 0.1, soil_temp_2: 14.92 },
    })} />);

    act(() => writeDisplayPreferences({ swtUnit: 'pF' }));

    expect(screen.getByText('1.29 pF')).toBeInTheDocument();
    expect(screen.getByText('0.00 pF')).toBeInTheDocument();
    expect(screen.getByText('Soil 14.0 °C')).toBeInTheDocument();
    expect(screen.getByText('Soil 14.9 °C')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Soil tension 1' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Soil tension 2' })).toBeInTheDocument();
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
      // No identified profile: the generic SDI-12 rows (a Tensiomark reports no EC).
      sdi12_probe_profile: null,
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
      sdi12_probe_profile: null,
      latest: { soil_temp_9: 18.5, vwc_9: 20.1 } as Device['latest_data'],
    })} />);
    expect(screen.getByText('18.5 °C').closest('button')).toBeNull();
    expect(screen.getByText('20.1 %').closest('button')).not.toBeNull();
  });

  it('opens Tensiomark history from canonical kPa and reprojects the mounted monitor when the preference changes', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const getHistory = await historyMock();
    vi.mocked(getHistory).mockResolvedValue([{ t: '2026-09-24T07:00:00.000Z', value: 1.97 }] as never);
    window.localStorage.setItem('osi.display.swtUnit', 'pF');
    render(<Sdi12SoilCard removeContext='farm' device={makeDevice({
      sdi12_probe_profile: 'TENSIOMARK',
      latest: { swt_1: 1.97 },
    })} />);
    fireEvent.click(within(screen.getByRole('group', { name: 'Soil tension 1' })).getByRole('button', { name: '1.29 pF' }));
    expect(await screen.findByRole('heading', { name: 'Soil tension 1 (pF)' })).toBeInTheDocument();
    expect(screen.getAllByText('1.29 pF').length).toBeGreaterThan(1);
    act(() => writeDisplayPreferences({ swtUnit: 'kPa' }));
    expect(await screen.findByRole('heading', { name: 'Soil tension 1 (kPa)' })).toBeInTheDocument();
    expect(screen.getAllByText('2.0 kPa').length).toBeGreaterThan(1);
    expect(getHistory).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
