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
    'addModal.generationGen1': 'Gen1 (standard)',
    'addModal.generationGen2': 'Gen2 / SV2 (Bluetooth, untested on hardware)',
    // react-i18next is fully mocked in this file, so nothing here ever touches the real
    // locale backend -- this literal only drives render plumbing (does the component ask for
    // the right key and display whatever it's given). The 'renders the shipped generation
    // hint' test below is what actually pins the real en/devices.json content, by importing
    // it directly and asserting it equals a correct literal written independently of this
    // table (vi.hoisted runs before module imports resolve, so this table cannot reference
    // the imported JSON itself -- see that test's comment for why the pin still holds).
    'addModal.generationHint':
      "If you're unsure, choose Gen1 — the gateway corrects it automatically once a Gen2 valve acknowledges a scheduled command. It cannot correct the other way: a wrong Gen2 pick needs manual repair.",
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

  it('renders the shipped generation hint, correctly describing the ACK-based trigger', async () => {
    render(<AddDeviceModal isOpen={true} onClose={vi.fn()} onDeviceAdded={vi.fn()} />);

    await waitFor(() => expect(devicesAPI.getCatalog).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Device Type'), { target: { value: 'STREGA_VALVE' } });

    // Pinned as an independent literal (not `translateForTest(...)`, which is just an echo of
    // whatever the mock table holds): correction requires an ACK-bearing uplink, which in turn
    // requires a downlink -- a schedule or command -- to have been sent first. A valve that has
    // never had anything scheduled never corrects no matter how often it "replies", so the old
    // "once a Gen2 valve replies" claim was false in exactly that case. This asserts against the
    // real shipped en/devices.json content directly, so reverting the file to the old claim
    // fails this test instead of silently passing against a stale copy of the string.
    const expectedHint =
      "If you're unsure, choose Gen1 — the gateway corrects it automatically once a Gen2 valve acknowledges a scheduled command. It cannot correct the other way: a wrong Gen2 pick needs manual repair.";
    expect(enDevices.addModal.generationHint).toBe(expectedHint);
    expect(screen.getByText(expectedHint)).toBeInTheDocument();
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

    // Reopen while the catalog fetch fails entirely. loadCatalog()'s own reset of
    // selectedType only runs inside `if (data.length > 0)`, and the whole call is wrapped in
    // a catch that only console.errors -- so before this fix, a failed fetch left the
    // previous session's STREGA_VALVE selection in place instead of the form's declared
    // default. The un-refetched `catalog` state (still holding STREGA_VALVE as an option from
    // the earlier successful load) proves this isn't just an empty-dropdown side effect.
    vi.mocked(devicesAPI.getCatalog).mockRejectedValueOnce(new Error('network down'));
    rerender(<AddDeviceModal isOpen={false} onClose={onClose} onDeviceAdded={vi.fn()} />);
    rerender(<AddDeviceModal isOpen={true} onClose={onClose} onDeviceAdded={vi.fn()} />);

    await waitFor(() => expect(devicesAPI.getCatalog).toHaveBeenCalledTimes(2));

    expect(screen.queryByLabelText('Valve generation')).not.toBeInTheDocument();
  });
});
