import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Device } from '../../../types/farming';
import { fetchSdi12Profiles, postSdi12Identify, putSdi12Config } from '../../../services/api';
import { Sdi12SettingsModal } from '../Sdi12SettingsModal';

vi.mock('../../../services/api', async () => {
  const actual = await vi.importActual<typeof import('../../../services/api')>('../../../services/api');
  return {
    ...actual,
    fetchSdi12Profiles: vi.fn(),
    postSdi12Identify: vi.fn(),
    putSdi12Config: vi.fn(),
  };
});

// t() returns the key itself, matching this codebase's convention
// (CreateZoneModal.uicore.test.tsx, ValveCard.test.tsx, ZoneConfigModal.test.tsx) --
// assertions below query the i18n key, not rendered English prose.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const device: Device = {
  deveui: '70B3D5E75E004202',
  name: 'SDI-12 row 3',
  type_id: 'DRAGINO_SDI12',
  latest_data: { bat_v: 3.3 },
  sdi12_probe_status: 'unmatched',
  sdi12_identity: 'aM!5SDI-12 probe',
};

describe('Sdi12SettingsModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchSdi12Profiles).mockResolvedValue({
      profiles: [{
        id: 'TENSIOMARK',
        label: 'ecoTech Tensiomark',
        provisional: true,
        expectedValues: 2,
        defaultDepthsCm: [30],
        channels: ['swt_1', 'soil_temp_1'],
      }],
    });
    vi.mocked(putSdi12Config).mockResolvedValue(undefined);
    vi.mocked(postSdi12Identify).mockResolvedValue(undefined);
  });

  it('lists profiles from the API and saves profile + depths', async () => {
    render(<Sdi12SettingsModal device={device} onClose={vi.fn()} onUpdate={vi.fn()} />);

    expect(await screen.findByRole('option', { name: /ecoTech Tensiomark.*unverified/i })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Probe profile'), { target: { value: 'TENSIOMARK' } });
    fireEvent.change(screen.getByLabelText('Depth slot 1 (cm)'), { target: { value: '35' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(putSdi12Config).toHaveBeenCalledWith(device.deveui, {
        probe_profile: 'TENSIOMARK',
        depths: { '1': 35 },
      });
    });
  });

  it('omits depths when the user edits none', async () => {
    render(<Sdi12SettingsModal device={device} onClose={vi.fn()} onUpdate={vi.fn()} />);

    await screen.findByRole('option', { name: /ecoTech Tensiomark.*unverified/i });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(putSdi12Config).toHaveBeenCalledWith(device.deveui, {
        probe_profile: 'TENSIOMARK',
      });
    });
  });

  it('detect button posts identify', async () => {
    // `device` fixture already carries sdi12_probe_status: 'unmatched' -- a
    // non-null status means an attempt has already happened, so the button
    // reads the re-check key (t() is mocked to return the key itself).
    render(<Sdi12SettingsModal device={device} onClose={vi.fn()} onUpdate={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'sdi12.reCheck' }));

    await waitFor(() => expect(postSdi12Identify).toHaveBeenCalledWith(device.deveui));
    expect(screen.getByText(/identification requested|pending/i)).toBeInTheDocument();
  });

  it('surfaces the server message on a failed identify request', async () => {
    vi.mocked(postSdi12Identify).mockRejectedValueOnce({
      isAxiosError: true,
      response: { data: { message: 'device is missing ChirpStack registration data; cannot identify' } },
    });
    render(<Sdi12SettingsModal device={device} onClose={vi.fn()} onUpdate={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'sdi12.reCheck' }));
    await waitFor(() =>
      expect(screen.getByText('device is missing ChirpStack registration data; cannot identify')).toBeInTheDocument(),
    );
  });

  it('shows the first-attempt identify label when the device has never been probed', async () => {
    const neverAttempted: Device = { ...device, sdi12_probe_status: undefined };
    render(<Sdi12SettingsModal device={neverAttempted} onClose={vi.fn()} onUpdate={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'sdi12.identify' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'sdi12.reCheck' })).not.toBeInTheDocument();
  });

  it('renders the client-derived no-response state once pending_identify has aged past the timeout', async () => {
    const stale = new Date(Date.now() - 16 * 60000).toISOString();
    const timedOut: Device = { ...device, sdi12_probe_status: 'pending_identify', updated_at: stale };
    render(<Sdi12SettingsModal device={timedOut} onClose={vi.fn()} onUpdate={vi.fn()} />);
    expect(await screen.findByText('sdi12.noResponse')).toBeInTheDocument();
    expect(screen.getByText('sdi12.actButtonHint')).toBeInTheDocument();
    expect(screen.queryByText(/Identification pending for/)).not.toBeInTheDocument();
  });

  it('still shows the plain pending copy before the no-response timeout elapses', async () => {
    const recent = new Date(Date.now() - 5 * 60000).toISOString();
    const stillPending: Device = { ...device, sdi12_probe_status: 'pending_identify', updated_at: recent };
    render(<Sdi12SettingsModal device={stillPending} onClose={vi.fn()} onUpdate={vi.fn()} />);
    expect(await screen.findByText(/Identification pending for 5 minutes\./)).toBeInTheDocument();
    expect(screen.queryByText('sdi12.noResponse')).not.toBeInTheDocument();
  });

  it('uses the dynamic layout instead of legacy value-count for Sentek', async () => {
    vi.mocked(fetchSdi12Profiles).mockResolvedValue({
      profiles: [
        {
          id: 'TENSIOMARK',
          label: 'ecoTech Tensiomark',
          provisional: true,
          expectedValues: 2,
          defaultDepthsCm: [30],
          channels: ['swt_1', 'soil_temp_1'],
        },
        {
          id: 'SENTEK_ENVIROSCAN',
          label: 'Sentek EnviroSCAN',
          provisional: true,
          expectedValues: null,
          defaultDepthsCm: [],
          channels: ['vwc_1', 'vwc_2', 'vwc_3', 'vwc_4', 'vwc_5', 'vwc_6', 'vwc_7', 'vwc_8'],
        },
      ],
    });
    render(<Sdi12SettingsModal device={device} onClose={vi.fn()} onUpdate={vi.fn()} />);

    // TENSIOMARK is the default selection (device.sdi12_probe_profile is unset,
    // so the modal falls back to the first profile returned): fixed cardinality,
    // no value-count field.
    await screen.findByRole('option', { name: /ecoTech Tensiomark/i });
    expect(screen.queryByLabelText('sdi12.valueCount')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Probe profile'), { target: { value: 'SENTEK_ENVIROSCAN' } });
    expect(screen.queryByLabelText('sdi12.valueCount')).not.toBeInTheDocument();
    expect(await screen.findByLabelText('SDI-12 address')).toHaveValue('L');
    fireEvent.change(screen.getByLabelText('Depth 1 (cm)'), { target: { value: '15' } });
    fireEvent.change(screen.getByLabelText('Module type 1'), { target: { value: 'TRISCAN' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(putSdi12Config).toHaveBeenCalledWith(device.deveui, {
        probe_profile: 'SENTEK_ENVIROSCAN',
        address: 'L',
        sensors: [{ channel: 1, response_position: 1, depth_cm: 15, type: 'TRISCAN' }],
      });
    });
  });

  it('loads a saved Sentek layout without renumbering stable channels', async () => {
    vi.mocked(fetchSdi12Profiles).mockResolvedValue({
      profiles: [{
        id: 'SENTEK_ENVIROSCAN',
        label: 'Sentek EnviroSCAN',
        provisional: true,
        expectedValues: null,
        defaultDepthsCm: [],
        channels: ['vwc_1'],
      }],
    });
    const withLayout: Device = { ...device, sdi12_probe_profile: 'SENTEK_ENVIROSCAN', sdi12_channel_layout_json: {
      version: 1, address: 'L', sensors: [
        { channel: 9, response_position: 1, depth_cm: 70, type: 'TRISCAN' },
        { channel: 7, response_position: 2, depth_cm: 80, type: 'ENVIROSCAN' },
      ],
    } };
    render(<Sdi12SettingsModal device={withLayout} onClose={vi.fn()} onUpdate={vi.fn()} />);

    expect(await screen.findByLabelText('Channel 1')).toHaveValue(9);
    expect(screen.getByLabelText('Channel 2')).toHaveValue(7);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(putSdi12Config).toHaveBeenCalledWith(withLayout.deveui, {
        probe_profile: 'SENTEK_ENVIROSCAN',
        address: 'L',
        sensors: withLayout.sdi12_channel_layout_json?.sensors,
      });
    });
  });

  it('adds at most ten Sentek modules and renumbers response positions after removal', async () => {
    vi.mocked(fetchSdi12Profiles).mockResolvedValue({ profiles: [{
      id: 'SENTEK_ENVIROSCAN', label: 'Sentek EnviroSCAN', provisional: true,
      expectedValues: null, defaultDepthsCm: [], channels: ['vwc_1'],
    }] });
    render(<Sdi12SettingsModal device={device} onClose={vi.fn()} onUpdate={vi.fn()} />);

    const add = await screen.findByRole('button', { name: 'Add module' });
    for (let index = 0; index < 9; index += 1) fireEvent.click(add);
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(10);
    expect(add).toBeDisabled();

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]);
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(9);
    expect(screen.getByLabelText('Response position 1')).toHaveValue(1);
    expect(screen.getByLabelText('Channel 1')).toHaveValue(2);
    expect(add).toBeEnabled();
  });

  it('rejects duplicate Sentek channels before calling the API', async () => {
    vi.mocked(fetchSdi12Profiles).mockResolvedValue({ profiles: [{
      id: 'SENTEK_ENVIROSCAN', label: 'Sentek EnviroSCAN', provisional: true,
      expectedValues: null, defaultDepthsCm: [], channels: ['vwc_1'],
    }] });
    render(<Sdi12SettingsModal device={device} onClose={vi.fn()} onUpdate={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Add module' }));
    fireEvent.change(screen.getByLabelText('Channel 2'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Channels, response positions, and positive depths must be unique and valid.')).toBeInTheDocument();
    expect(putSdi12Config).not.toHaveBeenCalled();
  });

  it('surfaces the server message on a failed save', async () => {
    vi.mocked(putSdi12Config).mockRejectedValueOnce({
      isAxiosError: true,
      response: { data: { message: 'Depths must be whole centimeters between 0 and 500.' } },
    });
    render(<Sdi12SettingsModal device={device} onClose={vi.fn()} onUpdate={vi.fn()} />);
    await screen.findByRole('option', { name: /ecoTech Tensiomark.*unverified/i });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.getByText('Depths must be whole centimeters between 0 and 500.')).toBeInTheDocument(),
    );
  });
});
