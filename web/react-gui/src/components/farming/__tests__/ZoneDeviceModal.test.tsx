import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZoneDeviceModal } from '../ZoneDeviceModal';
import { devicesAPI, irrigationZonesAPI } from '../../../services/api';

vi.mock('../../../services/api', () => ({
  devicesAPI: { add: vi.fn(), getCatalog: vi.fn() },
  irrigationZonesAPI: { assignDevice: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && options.zoneName ? `${key}:${options.zoneName}` : key,
  }),
}));

const devices = [
  {
    deveui: 'AAAA000000000001',
    name: 'Spare sensor',
    type_id: 'DRAGINO_LSN50',
    irrigation_zone_id: null,
  },
] as never[];

describe('ZoneDeviceModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Two entries, deliberately: with a single-item catalog `catalog[0].id` and
    // the selected option are the same string, so the assertion below cannot
    // tell "sent the selection" from "sent the first catalog row".
    vi.mocked(devicesAPI.getCatalog).mockResolvedValue([
      { id: 'DRAGINO_LSN50', name: 'Dragino LSN50' },
      { id: 'STREGA_VALVE', name: 'Strega valve' },
    ] as never);
    vi.mocked(devicesAPI.add).mockResolvedValue({} as never);
    vi.mocked(irrigationZonesAPI.assignDevice).mockResolvedValue(undefined);
  });

  const renderModal = (onChanged = vi.fn()) => {
    render(
      <ZoneDeviceModal
        isOpen
        onClose={vi.fn()}
        onChanged={onChanged}
        zoneId={7}
        zoneName="North Block"
        availableDevices={devices}
      />,
    );
    return onChanged;
  };

  it('assigns an existing device from the first tab', async () => {
    const onChanged = renderModal();

    fireEvent.change(screen.getByLabelText('assignModal.selectDevice'), {
      target: { value: 'AAAA000000000001' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'assignModal.submit' }));

    await waitFor(() =>
      expect(irrigationZonesAPI.assignDevice).toHaveBeenCalledWith(7, 'AAAA000000000001'),
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it('names the current zone when the assign conflicts and refreshes the list', async () => {
    const onChanged = renderModal();
    vi.mocked(irrigationZonesAPI.assignDevice).mockRejectedValueOnce({
      response: {
        status: 409,
        data: {
          message: 'Device is already assigned to a zone',
          current_zone_id: 3,
          current_zone_name: 'South Block',
        },
      },
    });

    fireEvent.change(screen.getByLabelText('assignModal.selectDevice'), {
      target: { value: 'AAAA000000000001' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'assignModal.submit' }));

    await screen.findByText('zoneDeviceModal.assignConflict:South Block');
    expect(onChanged).toHaveBeenCalled();
  });

  it('does not render an empty zone name when the conflict zone was deleted', async () => {
    renderModal();
    vi.mocked(irrigationZonesAPI.assignDevice).mockRejectedValueOnce({
      response: {
        status: 409,
        data: {
          message: 'Device is already assigned to a zone',
          current_zone_id: 3,
          current_zone_name: null,
          current_zone_deleted: true,
        },
      },
    });

    fireEvent.change(screen.getByLabelText('assignModal.selectDevice'), {
      target: { value: 'AAAA000000000001' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'assignModal.submit' }));

    await screen.findByText('zoneDeviceModal.assignConflictDeleted');
    expect(screen.queryByText('zoneDeviceModal.assignConflict:')).not.toBeInTheDocument();
  });

  it('registers a new device into the fixed zone from the second tab', async () => {
    const onChanged = renderModal();

    fireEvent.click(screen.getByRole('tab', { name: 'zoneDeviceModal.tabRegister' }));
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Dragino LSN50' })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText('addModal.deviceName'), {
      target: { value: 'New tree' },
    });
    fireEvent.change(screen.getByLabelText('addModal.deveui'), {
      target: { value: 'BBBB000000000002' },
    });
    fireEvent.change(screen.getByLabelText('addModal.appkey'), {
      target: { value: 'AABBCCDDEEFF00112233445566778899' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'zoneDeviceModal.registerSubmit' }));

    await waitFor(() =>
      expect(devicesAPI.add).toHaveBeenCalledWith({
        deveui: 'BBBB000000000002',
        name: 'New tree',
        type_id: 'DRAGINO_LSN50',
        appkey: 'AABBCCDDEEFF00112233445566778899',
        zone_id: 7,
      }),
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it('blocks registration while the catalog is still loading', () => {
    vi.mocked(devicesAPI.getCatalog).mockReturnValueOnce(new Promise(() => {}));
    renderModal();

    fireEvent.click(screen.getByRole('tab', { name: 'zoneDeviceModal.tabRegister' }));
    fireEvent.change(screen.getByLabelText('addModal.deviceName'), {
      target: { value: 'Early submit' },
    });
    fireEvent.change(screen.getByLabelText('addModal.deveui'), {
      target: { value: 'BBBB000000000004' },
    });
    const submit = screen.getByRole('button', { name: 'zoneDeviceModal.registerSubmit' });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);

    expect(devicesAPI.add).not.toHaveBeenCalled();
  });

  it('registers the device type the operator selected, not the first catalog row', async () => {
    renderModal();

    fireEvent.click(screen.getByRole('tab', { name: 'zoneDeviceModal.tabRegister' }));
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Strega valve' })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText('addModal.deviceType'), {
      target: { value: 'STREGA_VALVE' },
    });
    fireEvent.change(screen.getByLabelText('addModal.deviceName'), {
      target: { value: 'North valve' },
    });
    fireEvent.change(screen.getByLabelText('addModal.deveui'), {
      target: { value: 'BBBB000000000003' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'zoneDeviceModal.registerSubmit' }));

    await waitFor(() =>
      expect(devicesAPI.add).toHaveBeenCalledWith(
        expect.objectContaining({ type_id: 'STREGA_VALVE' }),
      ),
    );
  });

  it('surfaces a bounded ChirpStack error inside the modal', async () => {
    renderModal();
    vi.mocked(devicesAPI.add).mockRejectedValueOnce({
      response: { status: 503, data: { message: 'ChirpStack unreachable' } },
    });

    fireEvent.click(screen.getByRole('tab', { name: 'zoneDeviceModal.tabRegister' }));
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Dragino LSN50' })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText('addModal.deviceName'), {
      target: { value: 'New tree' },
    });
    fireEvent.change(screen.getByLabelText('addModal.deveui'), {
      target: { value: 'BBBB000000000002' },
    });
    fireEvent.change(screen.getByLabelText('addModal.appkey'), {
      target: { value: 'AABBCCDDEEFF00112233445566778899' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'zoneDeviceModal.registerSubmit' }));

    await screen.findByText('ChirpStack unreachable');
  });
});
