import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Device } from '../../../types/farming';
import { fetchSdi12Profiles, postSdi12Identify, putSdi12Config } from '../../../services/api';
import { Sdi12SettingsModal } from '../Sdi12SettingsModal';

vi.mock('../../../services/api', () => ({
  fetchSdi12Profiles: vi.fn(),
  postSdi12Identify: vi.fn(),
  putSdi12Config: vi.fn(),
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
    render(<Sdi12SettingsModal device={device} onClose={vi.fn()} onUpdate={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Detect probe' }));

    await waitFor(() => expect(postSdi12Identify).toHaveBeenCalledWith(device.deveui));
    expect(screen.getByText(/identification requested|pending/i)).toBeInTheDocument();
  });
});
