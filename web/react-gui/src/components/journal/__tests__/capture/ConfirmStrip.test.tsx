// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { ConfirmStrip } from '../../capture/ConfirmStrip';

const props = {
  activity: { label: 'Irrigation', value: 'Irrigation', step: 'activity' as const },
  plot: { label: 'Plot', value: 'North field', step: 'where' as const },
  layout: { label: 'Growing setting', value: 'Quick · v1', step: 'where' as const },
  occurrence: {
    label: 'When', value: '16 Jul 2026 08:30', timezone: 'Europe/Zurich', step: 'details' as const,
  },
  values: [
    { label: 'Water amount', value: '12', unit: 'mm', attribute_code: 'attr.amount' },
    { label: 'Method', value: 'Drip', attribute_code: 'attr.method' },
  ],
  onEdit: vi.fn(),
  onFinalize: vi.fn(),
};

describe('ConfirmStrip', () => {
  it('renders every interpreted token with its unit and routes token edits to their step', () => {
    render(<ConfirmStrip {...props} />);

    expect(screen.getByRole('heading', { name: 'capture.confirm.title' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Irrigation/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /North field/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Quick/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /16 Jul 2026 08:30/ })).toBeInTheDocument();
    expect(screen.getByText('Europe/Zurich')).toBeInTheDocument();
    expect(screen.getByText('12 mm')).toBeInTheDocument();
    expect(screen.getByText('Drip')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Irrigation/ }));
    fireEvent.click(screen.getByRole('button', { name: /North field/ }));
    fireEvent.click(screen.getByRole('button', { name: /Quick/ }));
    fireEvent.click(screen.getByRole('button', { name: /16 Jul 2026 08:30/ }));
    fireEvent.click(screen.getByRole('button', { name: /Water amount/ }));
    expect(props.onEdit).toHaveBeenNthCalledWith(1, 'activity');
    expect(props.onEdit).toHaveBeenNthCalledWith(2, 'where');
    expect(props.onEdit).toHaveBeenNthCalledWith(3, 'where');
    expect(props.onEdit).toHaveBeenNthCalledWith(4, 'details');
    expect(props.onEdit).toHaveBeenNthCalledWith(5, 'details');
  });

  it.each([
    ['validation', { validationInFlight: true }],
    ['duplicate lookup', { duplicateInFlight: true }],
    ['save', { saveInFlight: true }],
  ])('disables finalize while %s is in flight', (_name, flags) => {
    render(<ConfirmStrip {...props} {...flags} />);
    expect(screen.getByRole('button', { name: 'capture.finish' })).toBeDisabled();
  });

  it('calls finalize only from the explicit finish control', () => {
    render(<ConfirmStrip {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));
    expect(props.onFinalize).toHaveBeenCalledTimes(1);
  });

  it('does not expose edit or finalize actions for a successful receipt', () => {
    render(<ConfirmStrip {...props} readOnly />);
    expect(screen.getByRole('button', { name: /Irrigation/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'capture.finish' })).toBeDisabled();
  });

  it('keeps repeated value groups independently keyed', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      render(<ConfirmStrip {...props} values={[
        { label: 'Water amount', value: '12', unit: 'mm', attribute_code: 'attr.amount', group_index: 0 },
        { label: 'Water amount', value: '12', unit: 'mm', attribute_code: 'attr.amount', group_index: 1 },
      ]} />);
      expect(screen.getAllByText('12 mm')).toHaveLength(2);
      expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining('same key'));
    } finally {
      consoleError.mockRestore();
    }
  });
});
