// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateZoneModal } from '../CreateZoneModal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../services/api', () => ({
  irrigationZonesAPI: { create: vi.fn() },
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
});
