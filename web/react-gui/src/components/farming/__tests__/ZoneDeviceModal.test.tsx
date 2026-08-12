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
    vi.mocked(devicesAPI.getCatalog).mockResolvedValue([
      { id: 'DRAGINO_LSN50', name: 'Dragino LSN50' },
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

  it('registers a new device into the fixed zone from the second tab', async () => {
    const onChanged = renderModal();

    fireEvent.click(screen.getByRole('tab', { name: 'zoneDeviceModal.tabRegister' }));
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

  it('surfaces a bounded ChirpStack error inside the modal', async () => {
    renderModal();
    vi.mocked(devicesAPI.add).mockRejectedValueOnce({
      response: { status: 503, data: { message: 'ChirpStack unreachable' } },
    });

    fireEvent.click(screen.getByRole('tab', { name: 'zoneDeviceModal.tabRegister' }));
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
