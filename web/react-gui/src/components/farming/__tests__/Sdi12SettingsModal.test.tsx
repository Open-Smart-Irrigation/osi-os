import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Device } from '../../../types/farming';
import { devicesAPI, fetchSdi12Profiles, postSdi12Identify, postSdi12RecipeApply, postSdi12RecipeRollback, putSdi12Config } from '../../../services/api';
import { Sdi12SettingsModal } from '../Sdi12SettingsModal';

vi.mock('../../../services/api', async () => {
  const actual = await vi.importActual<typeof import('../../../services/api')>('../../../services/api');
  return {
    ...actual,
    fetchSdi12Profiles: vi.fn(),
    postSdi12Identify: vi.fn(),
    postSdi12RecipeApply: vi.fn(),
    postSdi12RecipeRollback: vi.fn(),
    devicesAPI: { getAll: vi.fn() },
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
    vi.mocked(postSdi12RecipeApply).mockResolvedValue({ desired_version: 1, status: 'queueing' } as never);
    vi.mocked(postSdi12RecipeRollback).mockResolvedValue({ desired_version: 1, status: 'queueing' } as never);
    vi.mocked(devicesAPI.getAll).mockResolvedValue([]);
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
    expect(await screen.findByLabelText('SDI-12 address')).toHaveValue('');
    expect(screen.queryByText(/TriSCAN VIC decoding remains disabled/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('SDI-12 address'), { target: { value: 'L' } });
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
    fireEvent.change(screen.getByLabelText('SDI-12 address'), { target: { value: 'L' } });
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

  it('prefills only a valid discovered Sentek address and keeps an unsaved layout unapplied', async () => {
    vi.mocked(fetchSdi12Profiles).mockResolvedValue({ profiles: [{
      id: 'SENTEK_ENVIROSCAN', label: 'Sentek EnviroSCAN', provisional: true,
      expectedValues: null, defaultDepthsCm: [], channels: ['vwc_1'],
    }] });
    render(<Sdi12SettingsModal device={{ ...device, sdi12_discovered_address: '7' }} onClose={vi.fn()} onUpdate={vi.fn()} />);
    expect(await screen.findByLabelText('SDI-12 address')).toHaveValue('7');
    expect(screen.getByRole('button', { name: 'sdi12.apply' })).toBeDisabled();
  });

  it('prefills an untouched empty Sentek address when discovery arrives while the modal remains open', async () => {
    vi.mocked(fetchSdi12Profiles).mockResolvedValue({ profiles: [{
      id: 'SENTEK_ENVIROSCAN', label: 'Sentek EnviroSCAN', provisional: true,
      expectedValues: null, defaultDepthsCm: [], channels: ['vwc_1'],
    }] });
    const undiscovered: Device = { ...device, sdi12_probe_profile: 'SENTEK_ENVIROSCAN' };
    const { rerender } = render(<Sdi12SettingsModal device={undiscovered} onClose={vi.fn()} onUpdate={vi.fn()} />);

    expect(await screen.findByLabelText('SDI-12 address')).toHaveValue('');
    rerender(<Sdi12SettingsModal device={{ ...undiscovered, sdi12_discovered_address: '7' }} onClose={vi.fn()} onUpdate={vi.fn()} />);

    expect(screen.getByLabelText('SDI-12 address')).toHaveValue('7');
  });

  it('does not overwrite a manually edited Sentek address when discovery arrives', async () => {
    vi.mocked(fetchSdi12Profiles).mockResolvedValue({ profiles: [{
      id: 'SENTEK_ENVIROSCAN', label: 'Sentek EnviroSCAN', provisional: true,
      expectedValues: null, defaultDepthsCm: [], channels: ['vwc_1'],
    }] });
    const undiscovered: Device = { ...device, sdi12_probe_profile: 'SENTEK_ENVIROSCAN' };
    const { rerender } = render(<Sdi12SettingsModal device={undiscovered} onClose={vi.fn()} onUpdate={vi.fn()} />);

    const address = await screen.findByLabelText('SDI-12 address');
    fireEvent.change(address, { target: { value: 'A' } });
    rerender(<Sdi12SettingsModal device={{ ...undiscovered, sdi12_discovered_address: '7' }} onClose={vi.fn()} onUpdate={vi.fn()} />);

    expect(screen.getByLabelText('SDI-12 address')).toHaveValue('A');
  });

  it('does not replace a manually cleared Sentek address when discovery arrives', async () => {
    vi.mocked(fetchSdi12Profiles).mockResolvedValue({ profiles: [{
      id: 'SENTEK_ENVIROSCAN', label: 'Sentek EnviroSCAN', provisional: true,
      expectedValues: null, defaultDepthsCm: [], channels: ['vwc_1'],
    }] });
    const undiscovered: Device = { ...device, sdi12_probe_profile: 'SENTEK_ENVIROSCAN' };
    const { rerender } = render(<Sdi12SettingsModal device={undiscovered} onClose={vi.fn()} onUpdate={vi.fn()} />);

    const address = await screen.findByLabelText('SDI-12 address');
    fireEvent.change(address, { target: { value: 'A' } });
    fireEvent.change(address, { target: { value: '' } });
    rerender(<Sdi12SettingsModal device={{ ...undiscovered, sdi12_discovered_address: '7' }} onClose={vi.fn()} onUpdate={vi.fn()} />);

    expect(screen.getByLabelText('SDI-12 address')).toHaveValue('');
  });

  it('does not replace a saved Sentek layout address when discovery arrives', async () => {
    vi.mocked(fetchSdi12Profiles).mockResolvedValue({ profiles: [{
      id: 'SENTEK_ENVIROSCAN', label: 'Sentek EnviroSCAN', provisional: true,
      expectedValues: null, defaultDepthsCm: [], channels: ['vwc_1'],
    }] });
    const saved: Device = {
      ...device,
      sdi12_probe_profile: 'SENTEK_ENVIROSCAN',
      sdi12_channel_layout_json: {
        version: 1,
        address: 'A',
        sensors: [{ channel: 1, response_position: 1, depth_cm: 10, type: 'ENVIROSCAN' }],
      },
    };
    const { rerender } = render(<Sdi12SettingsModal device={saved} onClose={vi.fn()} onUpdate={vi.fn()} />);

    expect(await screen.findByLabelText('SDI-12 address')).toHaveValue('A');
    rerender(<Sdi12SettingsModal device={{ ...saved, sdi12_discovered_address: '7' }} onClose={vi.fn()} onUpdate={vi.fn()} />);

    expect(screen.getByLabelText('SDI-12 address')).toHaveValue('A');
  });

  it('saves before Apply, confirms the normal cadence, prevents double clicks, and exposes compatible rollback', async () => {
    vi.mocked(fetchSdi12Profiles).mockResolvedValue({ profiles: [{
      id: 'SENTEK_ENVIROSCAN', label: 'Sentek EnviroSCAN', provisional: true,
      expectedValues: null, defaultDepthsCm: [], channels: ['vwc_1'],
    }] });
    const saved = { ...device, sdi12_probe_profile: 'SENTEK_ENVIROSCAN', sdi12_channel_layout_json: {
      version: 1 as const, address: '7', sensors: [{ channel: 1, response_position: 1, depth_cm: 10, type: 'ENVIROSCAN' as const }],
    }, sdi12_recipe_deployment: { desired_version: 1, desired_layout_hash: 'abc', status: 'degraded' as const, queued_at: null, queue_drained_at: null, commissioning_deadline_at: null, last_observed_at: null, compatible_at: null, updated_at: null, frame_count: 1, compatible_available: true, last_error_code: 'queue_delivery_timeout' } };
    const onUpdate = vi.fn();
    render(<Sdi12SettingsModal device={saved} onClose={vi.fn()} onUpdate={onUpdate} />);
    fireEvent.click(await screen.findByRole('button', { name: 'sdi12.apply' }));
    expect(screen.getByText('sdi12.applyConfirmation')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'sdi12.confirmApply' }));
    await waitFor(() => expect(postSdi12RecipeApply).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/queue_delivery_timeout/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'sdi12.rollback' })).toBeInTheDocument();
  });

  it.each([
    ['address', () => fireEvent.change(screen.getByLabelText('SDI-12 address'), { target: { value: '8' } })],
    ['channel', () => fireEvent.change(screen.getByLabelText('Channel 1'), { target: { value: '2' } })],
    ['depth', () => fireEvent.change(screen.getByLabelText('Depth 1 (cm)'), { target: { value: '20' } })],
    ['duplicate channel', () => { fireEvent.click(screen.getByRole('button', { name: 'Add module' })); fireEvent.change(screen.getByLabelText('Channel 2'), { target: { value: '1' } }); }],
    ['response position', () => fireEvent.change(screen.getByLabelText('Response position 1'), { target: { value: '2' } })],
  ])('disables Apply when the persisted layout is edited by %s', async (_change, change) => {
    vi.mocked(fetchSdi12Profiles).mockResolvedValue({ profiles: [{
      id: 'SENTEK_ENVIROSCAN', label: 'Sentek EnviroSCAN', provisional: true,
      expectedValues: null, defaultDepthsCm: [], channels: ['vwc_1'],
    }] });
    const persisted: Device = { ...device, sdi12_probe_profile: 'SENTEK_ENVIROSCAN', sdi12_channel_layout_json: {
      version: 1, address: '7', sensors: [
        { channel: 1, response_position: 1, depth_cm: 10, type: 'ENVIROSCAN' },
        { channel: 2, response_position: 2, depth_cm: 30, type: 'TRISCAN' },
      ],
    } };
    render(<Sdi12SettingsModal device={persisted} onClose={vi.fn()} onUpdate={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'sdi12.apply' })).toBeEnabled();
    change();
    expect(screen.getByRole('button', { name: 'sdi12.apply' })).toBeDisabled();
  });

  it('keeps Apply disabled after Save until a refreshed device confirms the saved layout', async () => {
    vi.mocked(fetchSdi12Profiles).mockResolvedValue({ profiles: [{
      id: 'SENTEK_ENVIROSCAN', label: 'Sentek EnviroSCAN', provisional: true,
      expectedValues: null, defaultDepthsCm: [], channels: ['vwc_1'],
    }] });
    let resolveRefresh: (rows: Device[]) => void = () => undefined;
    vi.mocked(devicesAPI.getAll).mockImplementation(() => new Promise((resolve) => { resolveRefresh = resolve; }));
    render(<Sdi12SettingsModal device={{ ...device, sdi12_probe_profile: 'SENTEK_ENVIROSCAN' }} onClose={vi.fn()} onUpdate={vi.fn()} />);
    const address = await screen.findByLabelText('SDI-12 address');
    fireEvent.change(address, { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putSdi12Config).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'sdi12.apply' })).toBeDisabled();
    resolveRefresh([{ ...device, sdi12_probe_profile: 'SENTEK_ENVIROSCAN', sdi12_channel_layout_json: {
      version: 1, address: '7', sensors: [{ channel: 1, response_position: 1, depth_cm: 10, type: 'ENVIROSCAN' }],
    } }]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'sdi12.apply' })).toBeEnabled());
  });

  it.each(['not_applied', 'queueing', 'queued', 'observed_once', 'observed_compatible', 'degraded'] as const)(
    'shows the bounded %s deployment state', async (status) => {
      vi.mocked(fetchSdi12Profiles).mockResolvedValue({ profiles: [{
        id: 'SENTEK_ENVIROSCAN', label: 'Sentek EnviroSCAN', provisional: true,
        expectedValues: null, defaultDepthsCm: [], channels: ['vwc_1'],
      }] });
      render(<Sdi12SettingsModal device={{ ...device, sdi12_probe_profile: 'SENTEK_ENVIROSCAN', sdi12_recipe_deployment: {
        desired_version: 1, desired_layout_hash: null, status, queued_at: null, queue_drained_at: null,
        commissioning_deadline_at: null, last_observed_at: null, compatible_at: null, updated_at: null,
        frame_count: null, compatible_available: false, last_error_code: status === 'degraded' ? 'queue_delivery_timeout' : null,
      } }} onClose={vi.fn()} onUpdate={vi.fn()} />);
      expect(await screen.findByText(`Deployment status: ${status}`)).toBeInTheDocument();
    },
  );
});
