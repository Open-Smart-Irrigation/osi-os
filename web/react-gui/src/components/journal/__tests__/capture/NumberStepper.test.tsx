import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && Object.keys(options).length > 0 ? `${key}:${JSON.stringify(options)}` : key,
    i18n: { resolvedLanguage: 'en-GB', language: 'en-GB' },
  }),
}));

import { NumberStepper } from '../../capture/NumberStepper';

describe('NumberStepper', () => {
  it('accepts the locale decimal separator without losing zero', () => {
    const onChange = vi.fn();
    render(
      <NumberStepper
        id="rate"
        label="Rate"
        locale="fr-FR"
        value={0}
        onChange={onChange}
      />,
    );

    const input = screen.getByRole('textbox', { name: 'Rate' });
    expect(input).toHaveAttribute('inputmode', 'decimal');
    expect(input).toHaveValue('0');

    fireEvent.change(input, { target: { value: '1,5' } });

    expect(onChange).toHaveBeenLastCalledWith(1.5);
  });

  it('provides large keyboard-operable step controls and clamps min/max', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <NumberStepper
        id="depth"
        label="Depth"
        locale="en-GB"
        value={1}
        min={0}
        max={2}
        step={0.5}
        onChange={onChange}
      />,
    );

    const decrease = screen.getByRole('button', { name: 'capture.form.decrease' });
    const increase = screen.getByRole('button', { name: 'capture.form.increase' });
    expect(decrease).toHaveClass('min-h-12', 'min-w-12');
    expect(increase).toHaveClass('min-h-12', 'min-w-12');

    fireEvent.click(increase);
    expect(onChange).toHaveBeenLastCalledWith(1.5);

    rerender(
      <NumberStepper
        id="depth"
        label="Depth"
        locale="en-GB"
        value={2}
        min={0}
        max={2}
        step={0.5}
        onChange={onChange}
      />,
    );
    expect(screen.getByRole('button', { name: 'capture.form.increase' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Depth' }), { key: 'ArrowDown' });
    expect(onChange).toHaveBeenLastCalledWith(1.5);
  });

  it('shows localized invalid, minimum, and maximum messages', () => {
    const onChange = vi.fn();
    const onValidityChange = vi.fn();
    render(
      <NumberStepper
        id="amount"
        label="Amount"
        locale="en-GB"
        value={null}
        min={1}
        max={10}
        onChange={onChange}
        onValidityChange={onValidityChange}
      />,
    );

    const input = screen.getByRole('textbox', { name: 'Amount' });
    fireEvent.change(input, { target: { value: 'nope' } });
    const invalidAlert = screen.getByRole('alert');
    expect(invalidAlert).toHaveTextContent('capture.validation.invalidNumber');
    expect(input).toHaveAttribute('aria-describedby', invalidAlert.id);
    expect(onValidityChange).toHaveBeenLastCalledWith(
      false,
      'capture.validation.invalidNumber',
    );

    fireEvent.change(input, { target: { value: '0' } });
    expect(screen.getByRole('alert')).toHaveTextContent('capture.validation.minimum');
    expect(onValidityChange).toHaveBeenLastCalledWith(
      false,
      'capture.validation.minimum:{"min":1}',
    );

    fireEvent.change(input, { target: { value: '11' } });
    expect(screen.getByRole('alert')).toHaveTextContent('capture.validation.maximum');
    expect(onValidityChange).toHaveBeenLastCalledWith(
      false,
      'capture.validation.maximum:{"max":10}',
    );

    fireEvent.change(input, { target: { value: '5' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onValidityChange).toHaveBeenLastCalledWith(true, undefined);
    expect(onChange).toHaveBeenLastCalledWith(5);
  });

  it('recomputes local validation when a controlled value changes', () => {
    const onChange = vi.fn();
    const onValidityChange = vi.fn();
    const { rerender } = render(
      <NumberStepper
        id="controlled"
        label="Controlled"
        value={5}
        min={1}
        max={10}
        onChange={onChange}
        onValidityChange={onValidityChange}
      />,
    );

    fireEvent.change(screen.getByRole('textbox', { name: 'Controlled' }), {
      target: { value: 'broken' },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('capture.validation.invalidNumber');

    rerender(
      <NumberStepper
        id="controlled"
        label="Controlled"
        value={6}
        min={1}
        max={10}
        onChange={onChange}
        onValidityChange={onValidityChange}
      />,
    );
    expect(screen.getByRole('textbox', { name: 'Controlled' })).toHaveValue('6');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    rerender(
      <NumberStepper
        id="controlled"
        label="Controlled"
        value={0}
        min={1}
        max={10}
        onChange={onChange}
        onValidityChange={onValidityChange}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('capture.validation.minimum');
  });

  // BUG 4: EntryForm's choice/boolean/text/product branches already show a
  // Required/Optional badge beside the field label; the number branches
  // (this component and NutrientRepeater) delegated to here and rendered
  // only the bare label, so a required number field showed no such signal.
  describe('BUG 4: Required/Optional status badge', () => {
    it('shows a Required badge exposed to the accessible name and marks the input aria-required', () => {
      render(
        <NumberStepper id="amount" label="Amount" value={null} required onChange={vi.fn()} />,
      );

      const input = screen.getByRole('textbox', { name: /Amount/ });
      expect(input).toHaveAccessibleName(/capture\.form\.required/);
      expect(input).toBeRequired();
      expect(input).toHaveAttribute('aria-required', 'true');
    });

    it('shows an Optional badge that is hidden from the accessible name when not required', () => {
      render(
        <NumberStepper id="amount" label="Amount" value={null} onChange={vi.fn()} />,
      );

      expect(screen.getByText('capture.form.optional')).toBeInTheDocument();
      const input = screen.getByRole('textbox', { name: 'Amount' });
      expect(input).not.toBeRequired();
      expect(input).toHaveAttribute('aria-required', 'false');
    });

    // POLISH 6: a required_any member's own `required` flag stays false, but
    // it is effectively required until one family member has a value, so it
    // gets its own "choose one" indicator instead of "Optional".
    it('shows a "choose one" indicator instead of Optional for a required_any member', () => {
      render(
        <NumberStepper
          id="amount"
          label="Amount"
          value={null}
          requiredAnyGroup
          onChange={vi.fn()}
        />,
      );

      expect(screen.queryByText('capture.form.optional')).not.toBeInTheDocument();
      const input = screen.getByRole('textbox', { name: /Amount/ });
      expect(input).toHaveAccessibleName(/capture\.form\.requiredChooseOne/);
      // Not unconditionally required in the native/aria sense -- only one
      // member of the family must have a value, not this one specifically.
      expect(input).not.toBeRequired();
    });
  });

  // POLISH 5: a small, unobtrusive hint line under the control.
  describe('POLISH 5: hint', () => {
    it('renders the hint when present and no error is active', () => {
      render(
        <NumberStepper id="amount" label="Amount" value={250} hint="Defaulted from plot area" onChange={vi.fn()} />,
      );

      expect(screen.getByText('Defaulted from plot area')).toBeInTheDocument();
    });

    it('does not render the hint once a validation error is showing', () => {
      render(
        <NumberStepper
          id="amount"
          label="Amount"
          value={null}
          min={1}
          hint="Defaulted from plot area"
          onChange={vi.fn()}
        />,
      );
      fireEvent.change(screen.getByRole('textbox', { name: 'Amount' }), { target: { value: '0' } });

      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.queryByText('Defaulted from plot area')).not.toBeInTheDocument();
    });
  });
});
