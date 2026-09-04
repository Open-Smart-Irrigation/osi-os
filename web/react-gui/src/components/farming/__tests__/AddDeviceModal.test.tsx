import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AddDeviceModal } from '../AddDeviceModal';
import { devicesAPI } from '../../../services/api';
import enDevices from '../../../../public/locales/en/devices.json';

const { translateForTest } = vi.hoisted(() => {
  const table: Record<string, string> = {
    'addModal.title': 'Add Device',
    'addModal.deviceType': 'Device Type',
    'addModal.deviceName': 'Device Name',
    'addModal.deviceNamePlaceholder': 'e.g., North Field, Main Valve',
    'addModal.deveui': 'DevEUI',
    'addModal.deveuiPlaceholder': '16 hex characters',
    'addModal.deveuiHint': 'Enter exactly 16 hexadecimal characters (0-9, A-F)',
    'addModal.deveuiInvalid': 'DevEUI must be exactly 16 hexadecimal characters',
    'addModal.appkey': 'AppKey',
    'addModal.appkeyPlaceholder': 'AABBCCDDEEFF00112233445566778899',
    'addModal.appkeyHint': '32 hex characters printed on the device label',
    'addModal.generation': 'Valve generation',
    'addModal.generationGen1': 'Gen-1',
    'addModal.generationGen2': 'Gen-2',
    // react-i18next is fully mocked in this file, so nothing here ever touches the real
    'addModal.adding': 'Adding...',
    'addModal.submit': 'Add Device',
    'addModal.failed': 'Failed to add device',
    cancel: 'Cancel',
  };
  return {
    translateForTest: (key: string, fallback?: string): string => table[key] ?? fallback ?? key,
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => translateForTest(key, fallback),
  }),
}));

vi.mock('../../../services/api', () => ({
  devicesAPI: {
    getCatalog: vi.fn(),
    add: vi.fn(),
  },
}));

const catalog = [
  { id: 'KIWI_SENSOR', name: 'Kiwi Sensor' },
  { id: 'STREGA_VALVE', name: 'STREGA Valve' },
];

function fillRequiredFields() {
  fireEvent.change(screen.getByLabelText('Device Name'), { target: { value: 'North Valve' } });
  fireEvent.change(screen.getByLabelText('DevEUI'), { target: { value: '0016C001F1000001' } });
}

describe('AddDeviceModal generation control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(devicesAPI.getCatalog).mockResolvedValue(catalog as any);
    vi.mocked(devicesAPI.add).mockResolvedValue({} as any);
  });

  it('does not show the generation control for a non-STREGA device type', async () => {
    render(<AddDeviceModal isOpen={true} onClose={vi.fn()} onDeviceAdded={vi.fn()} />);

    await waitFor(() => expect(devicesAPI.getCatalog).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Device Type'), { target: { value: 'KIWI_SENSOR' } });

    expect(screen.queryByLabelText('Valve generation')).not.toBeInTheDocument();
  });

  it('shows the generation control for STREGA_VALVE and defaults to GEN1', async () => {
    render(<AddDeviceModal isOpen={true} onClose={vi.fn()} onDeviceAdded={vi.fn()} />);

    await waitFor(() => expect(devicesAPI.getCatalog).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Device Type'), { target: { value: 'STREGA_VALVE' } });

    expect(screen.getByLabelText('Valve generation')).toBeInTheDocument();
    expect(screen.getByLabelText('Valve generation')).toHaveValue('GEN1');
  });

  it('includes strega_generation when submitting a STREGA valve', async () => {
    const onDeviceAdded = vi.fn();
    render(<AddDeviceModal isOpen={true} onClose={vi.fn()} onDeviceAdded={onDeviceAdded} />);

    await waitFor(() => expect(devicesAPI.getCatalog).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Device Type'), { target: { value: 'STREGA_VALVE' } });
    fillRequiredFields();
    fireEvent.change(screen.getByLabelText('Valve generation'), { target: { value: 'GEN2' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add Device' }));

    await waitFor(() => expect(devicesAPI.add).toHaveBeenCalled());
    expect(devicesAPI.add).toHaveBeenCalledWith(
      expect.objectContaining({ strega_generation: 'GEN2', type_id: 'STREGA_VALVE' }),
    );
  });

  it('omits strega_generation entirely when submitting a non-STREGA device', async () => {
    render(<AddDeviceModal isOpen={true} onClose={vi.fn()} onDeviceAdded={vi.fn()} />);

    await waitFor(() => expect(devicesAPI.getCatalog).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Device Type'), { target: { value: 'KIWI_SENSOR' } });
    fillRequiredFields();

    fireEvent.click(screen.getByRole('button', { name: 'Add Device' }));

    await waitFor(() => expect(devicesAPI.add).toHaveBeenCalled());
    const calls = vi.mocked(devicesAPI.add).mock.calls;
    const payload = calls[calls.length - 1][0];
    expect(payload).not.toHaveProperty('strega_generation');
  });

  it('omits strega_generation when the type is switched away from STREGA after picking GEN2', async () => {
    render(<AddDeviceModal isOpen={true} onClose={vi.fn()} onDeviceAdded={vi.fn()} />);

    await waitFor(() => expect(devicesAPI.getCatalog).toHaveBeenCalled());

    // Pick STREGA_VALVE and GEN2, then switch the device type away before submitting.
    fireEvent.change(screen.getByLabelText('Device Type'), { target: { value: 'STREGA_VALVE' } });
    fireEvent.change(screen.getByLabelText('Valve generation'), { target: { value: 'GEN2' } });
    fireEvent.change(screen.getByLabelText('Device Type'), { target: { value: 'KIWI_SENSOR' } });
    fillRequiredFields();

    fireEvent.click(screen.getByRole('button', { name: 'Add Device' }));

    await waitFor(() => expect(devicesAPI.add).toHaveBeenCalled());
    const calls = vi.mocked(devicesAPI.add).mock.calls;
    const payload = calls[calls.length - 1][0];
    expect(payload).not.toHaveProperty('strega_generation');
  });

  it('offers exactly Gen-1 and Gen-2 with no advisory hint', async () => {
    render(<AddDeviceModal isOpen={true} onClose={vi.fn()} onDeviceAdded={vi.fn()} />);

    await waitFor(() => expect(devicesAPI.getCatalog).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Device Type'), { target: { value: 'STREGA_VALVE' } });

    // Pinned against the real shipped en/devices.json, not the mock table (which is just an
    // echo): the labels must stay bare product names. The previous copy carried an
    // "untested on hardware" qualifier that a live Gen2 valve has since disproved, and an
    // advisory hint recommending Gen1 that was removed by product decision. Asserting the
    // key is absent makes a silent reintroduction fail here rather than ship.
    expect(enDevices.addModal.generationGen1).toBe('Gen-1');
    expect(enDevices.addModal.generationGen2).toBe('Gen-2');
    expect(enDevices.addModal).not.toHaveProperty('generationHint');

    const select = screen.getByLabelText('Valve generation') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Gen-1', 'Gen-2']);
  });

  it('resets generation and other fields to defaults when reopened after a cancel', async () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <AddDeviceModal isOpen={true} onClose={onClose} onDeviceAdded={vi.fn()} />,
    );

    await waitFor(() => expect(devicesAPI.getCatalog).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Device Type'), { target: { value: 'STREGA_VALVE' } });
    fireEvent.change(screen.getByLabelText('Valve generation'), { target: { value: 'GEN2' } });
    fireEvent.change(screen.getByLabelText('Device Name'), { target: { value: 'North Valve' } });
    fireEvent.change(screen.getByLabelText('DevEUI'), { target: { value: '0016C001F1000001' } });
    fireEvent.change(screen.getByLabelText('AppKey'), {
      target: { value: 'AABBCCDDEEFF00112233445566778899' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();

    // Simulate the parent closing then reopening the modal.
    rerender(<AddDeviceModal isOpen={false} onClose={onClose} onDeviceAdded={vi.fn()} />);
    rerender(<AddDeviceModal isOpen={true} onClose={onClose} onDeviceAdded={vi.fn()} />);

    await waitFor(() => expect(devicesAPI.getCatalog).toHaveBeenCalledTimes(2));

    fireEvent.change(screen.getByLabelText('Device Type'), { target: { value: 'STREGA_VALVE' } });

    expect(screen.getByLabelText('Valve generation')).toHaveValue('GEN1');
    expect(screen.getByLabelText('Device Name')).toHaveValue('');
    expect(screen.getByLabelText('DevEUI')).toHaveValue('');
    expect(screen.getByLabelText('AppKey')).toHaveValue('');
  });

  it('resets selectedType even when a reopen catalog fetch fails (m9)', async () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <AddDeviceModal isOpen={true} onClose={onClose} onDeviceAdded={vi.fn()} />,
    );

    await waitFor(() => expect(devicesAPI.getCatalog).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Device Type'), { target: { value: 'STREGA_VALVE' } });
    expect(screen.getByLabelText('Valve generation')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Reopen while the catalog fetch fails entirely. The fetch only sets selectedType inside
    // `if (data.length > 0)` and its catch merely console.errors, so without an explicit
    // up-front reset a failed fetch leaves the previous session's STREGA_VALVE selection in
    // place. 8fc83874 clears catalog/selectedType before the fetch, which is what makes the
    // failure fall through to the disabled-submit guard rather than to a stale pick.
    vi.mocked(devicesAPI.getCatalog).mockRejectedValueOnce(new Error('network down'));
    rerender(<AddDeviceModal isOpen={false} onClose={onClose} onDeviceAdded={vi.fn()} />);
    rerender(<AddDeviceModal isOpen={true} onClose={onClose} onDeviceAdded={vi.fn()} />);

    await waitFor(() => expect(devicesAPI.getCatalog).toHaveBeenCalledTimes(2));

    expect(screen.queryByLabelText('Valve generation')).not.toBeInTheDocument();
  });

  it('blocks submission while the catalog is unavailable, rather than falling back to a type', async () => {
    // 8fc83874: with catalog/selectedType cleared up front, a failed catalog fetch leaves
    // nothing selected. Submit must be disabled -- the earlier shape defaulted selectedType to
    // KIWI_SENSOR, so a failed fetch would happily register the device as a Kiwi sensor.
    vi.mocked(devicesAPI.getCatalog).mockRejectedValueOnce(new Error('network down'));
    render(<AddDeviceModal isOpen={true} onClose={vi.fn()} onDeviceAdded={vi.fn()} />);

    await waitFor(() => expect(devicesAPI.getCatalog).toHaveBeenCalled());
    fillRequiredFields();

    const submit = screen.getByRole('button', { name: 'Add Device' });
    expect(submit).toBeDisabled();

    fireEvent.click(submit);
    expect(devicesAPI.add).not.toHaveBeenCalled();
  });
});
