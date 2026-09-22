// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateZoneModal } from '../CreateZoneModal';
import { irrigationZonesAPI } from '../../../services/api';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../services/api', () => ({
  irrigationZonesAPI: { create: vi.fn().mockResolvedValue({}) },
}));

afterEach(cleanup);

describe('CreateZoneModal on ui-core', () => {
  it('renders a labelled dialog with the shared input treatment', () => {
    render(<CreateZoneModal isOpen onClose={() => {}} onZoneCreated={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'createZoneModal.title' })).toBeTruthy();
    expect(screen.getByLabelText('createZoneModal.zoneName').className).toContain('touch-target');
  });

  it('renders nothing while closed', () => {
    const { container } = render(
      <CreateZoneModal isOpen={false} onClose={() => {}} onZoneCreated={() => {}} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('closes from the dialog close control', () => {
    const onClose = vi.fn();
    render(<CreateZoneModal isOpen onClose={onClose} onZoneCreated={() => {}} />);
    screen.getByRole('button', { name: 'Close' }).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('refuses a control character and sends the trimmed name otherwise', async () => {
    render(<CreateZoneModal isOpen onClose={() => {}} onZoneCreated={() => {}} />);
    const input = screen.getByLabelText('createZoneModal.zoneName');

    fireEvent.change(input, { target: { value: 'Row\u00097' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    await waitFor(() =>
      expect(screen.getByText('rename.reason.name_control_characters')).toBeTruthy());
    expect(irrigationZonesAPI.create).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '  North block  ' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    await waitFor(() =>
      expect(irrigationZonesAPI.create).toHaveBeenCalledWith({ name: 'North block' }));
  });
});
