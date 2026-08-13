// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AddDeviceModal } from '../AddDeviceModal';
import { devicesAPI } from '../../../services/api';

vi.mock('../../../services/api', () => ({
  devicesAPI: { add: vi.fn(), getCatalog: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && options.zoneName ? `${key}:${options.zoneName}` : key,
  }),
}));

describe('AddDeviceModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(devicesAPI.getCatalog).mockResolvedValue([
      { id: 'DRAGINO_LSN50', name: 'Dragino LSN50' },
      { id: 'STREGA_VALVE', name: 'Strega valve' },
    ] as never);
    vi.mocked(devicesAPI.add).mockResolvedValue({} as never);
  });

  const renderModal = () => {
    render(
      <AddDeviceModal
        isOpen
        onClose={vi.fn()}
        onDeviceAdded={vi.fn()}
      />,
    );
  };

  it('registers the selected type from the header flow without a zone', async () => {
    renderModal();
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Strega valve' })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText('addModal.deviceType'), {
      target: { value: 'STREGA_VALVE' },
    });
    fireEvent.change(screen.getByLabelText('addModal.deviceName'), {
      target: { value: 'Header sensor' },
    });
    fireEvent.change(screen.getByLabelText('addModal.deveui'), {
      target: { value: 'AAAA000000000001' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'addModal.submit' }));

    await waitFor(() =>
      expect(devicesAPI.add).toHaveBeenCalledWith({
        deveui: 'AAAA000000000001',
        name: 'Header sensor',
        type_id: 'STREGA_VALVE',
        appkey: undefined,
      }),
    );
  });

  it('rejects a malformed DevEUI before calling the API', async () => {
    renderModal();
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Strega valve' })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText('addModal.deviceName'), {
      target: { value: 'Bad EUI' },
    });
    fireEvent.change(screen.getByLabelText('addModal.deveui'), {
      target: { value: 'not-an-eui' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'addModal.submit' }));

    await screen.findByText('addModal.deveuiInvalid');
    expect(devicesAPI.add).not.toHaveBeenCalled();
  });

  it('rejects a malformed AppKey before calling the API', async () => {
    renderModal();
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Strega valve' })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText('addModal.deviceName'), {
      target: { value: 'Bad key' },
    });
    fireEvent.change(screen.getByLabelText('addModal.deveui'), {
      target: { value: 'AAAA000000000001' },
    });
    fireEvent.change(screen.getByLabelText('addModal.appkey'), {
      target: { value: 'not-a-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'addModal.submit' }));

    await screen.findByText('addModal.appkeyInvalid');
    expect(devicesAPI.add).not.toHaveBeenCalled();
  });

  it('blocks registration while the catalog is still loading', () => {
    vi.mocked(devicesAPI.getCatalog).mockReturnValueOnce(new Promise(() => {}));
    renderModal();

    fireEvent.change(screen.getByLabelText('addModal.deviceName'), {
      target: { value: 'Early submit' },
    });
    fireEvent.change(screen.getByLabelText('addModal.deveui'), {
      target: { value: 'BBBB000000000004' },
    });
    const submit = screen.getByRole('button', { name: 'addModal.submit' });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);

    expect(devicesAPI.add).not.toHaveBeenCalled();
  });
});
