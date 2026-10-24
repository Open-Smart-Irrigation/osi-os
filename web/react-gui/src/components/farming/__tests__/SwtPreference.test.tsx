import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import i18next from 'i18next';
import { SwtPreference } from '../shared/SwtPreference';
import enValves from '../../../../public/locales/en/valves.json';
import deValves from '../../../../public/locales/de-CH/valves.json';

afterEach(() => cleanup());

async function renderWithLocale(value: number, language = 'en') {
  const instance = i18next.createInstance();
  await instance.init({
    lng: language,
    fallbackLng: 'en',
    resources: { en: { valves: enValves }, 'de-CH': { valves: deValves } },
    interpolation: { escapeValue: false },
  });
  return render(<I18nextProvider i18n={instance}><SwtPreference value={value} onChange={vi.fn()} /></I18nextProvider>);
}

describe('SwtPreference', () => {
  it('offers exact presets and keeps custom values', () => {
    const onChange = vi.fn();
    const instance = i18next.createInstance();
    return instance.init({ lng: 'en', resources: { en: { valves: enValves } } }).then(() => {
      render(<I18nextProvider i18n={instance}><SwtPreference value={29.9} onChange={onChange} /></I18nextProvider>);

      expect(screen.getByRole('radio', { name: /^Wet$/ })).not.toBeChecked();
      expect(screen.getByRole('radio', { name: /^Moist$/ })).not.toBeChecked();
      expect(screen.getByRole('radio', { name: /^Dry$/ })).not.toBeChecked();
      expect(screen.getByRole('radio', { name: /^Custom$/ })).toBeChecked();
      fireEvent.click(screen.getByRole('radio', { name: /^Wet$/ }));
      expect(onChange).toHaveBeenCalledWith(20);
    });
  });

  it('opens and focuses the advanced custom editor without changing its value', async () => {
    const onChange = vi.fn();
    const instance = i18next.createInstance();
    await instance.init({ lng: 'en', resources: { en: { valves: enValves } } });
    render(<I18nextProvider i18n={instance}><SwtPreference value={30} onChange={onChange} /></I18nextProvider>);
    const custom = screen.getByRole('radio', { name: /^Custom$/ });
    const input = screen.getByLabelText(/custom threshold in kpa/i) as HTMLInputElement;
    expect(input.closest('details')).not.toHaveAttribute('open');
    fireEvent.click(custom);
    expect(custom).toBeChecked();
    expect(screen.getByRole('radio', { name: /^Moist$/ })).not.toBeChecked();
    expect(input).toHaveFocus();
    expect(input.value).toBe('30');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '29.9' } });
    expect(onChange).toHaveBeenCalledWith(29.9);
  });

  it.each([20, 30, 50])('keeps Custom selected and emits an exact payload when edited to preset value %s', async candidate => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = React.useState(29.9);
      return <SwtPreference value={value} onChange={next => { onChange(next); setValue(next); }} />;
    }
    const instance = i18next.createInstance();
    await instance.init({ lng: 'en', resources: { en: { valves: enValves } } });
    render(<I18nextProvider i18n={instance}><Harness /></I18nextProvider>);
    const custom = screen.getByRole('radio', { name: /^Custom$/ });
    await user.click(custom);
    const input = screen.getByLabelText(/custom threshold in kpa/i) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, String(candidate));
    expect(custom).toBeChecked();
    expect(onChange).toHaveBeenLastCalledWith(candidate);
    expect(input).toHaveValue(candidate);
  });

  it('reconciles a new external value after a same-value preset selection', async () => {
    const instance = i18next.createInstance();
    await instance.init({ lng: 'en', resources: { en: { valves: enValves } } });
    const view = render(<I18nextProvider i18n={instance}><SwtPreference value={30} onChange={vi.fn()} /></I18nextProvider>);
    fireEvent.click(screen.getByRole('radio', { name: /^Custom$/ }));
    fireEvent.click(screen.getByRole('radio', { name: /^Moist$/ }));
    view.rerender(<I18nextProvider i18n={instance}><SwtPreference value={29.9} onChange={vi.fn()} /></I18nextProvider>);
    expect(screen.getByRole('radio', { name: /^Custom$/ })).toBeChecked();
  });

  it('shows each translated help only after its About control opens', async () => {
    const onChange = vi.fn();
    const instance = i18next.createInstance();
    await instance.init({ lng: 'en', resources: { en: { valves: enValves } } });
    render(<I18nextProvider i18n={instance}><SwtPreference value={50} onChange={onChange} /></I18nextProvider>);
    expect(screen.queryByText('Recommended.')).toBeNull();
    for (const [index, [about, text]] of [
      ['About Wet', 'Water sooner to keep the soil wetter.'],
      ['About Moist', 'Recommended. Allow some drying before watering.'],
      ['About Dry', 'Allow more drying before watering.'],
    ].entries()) {
      const help = screen.getByRole('button', { name: about });
      const panel = screen.getAllByRole('region', { hidden: true })[index];
      expect(panel).not.toBeVisible();
      fireEvent.click(help);
      expect(panel).toBeVisible();
      expect(panel).toHaveTextContent(text);
      fireEvent.click(help);
    }
    expect(screen.getByRole('radio', { name: /^Dry$/ })).toBeChecked();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps the preference legend and choices readable in dark mode', async () => {
    const instance = i18next.createInstance();
    await instance.init({ lng: 'en', resources: { en: { valves: enValves } } });
    render(<I18nextProvider i18n={instance}><SwtPreference value={30} onChange={vi.fn()} /></I18nextProvider>);
    const group = screen.getByRole('group', { name: 'Watering preference' });

    expect(group).toHaveClass('text-[var(--text)]');
    expect(screen.getByText('Watering preference').closest('legend')).toHaveClass('text-[var(--text-secondary)]');
  });

  it('uses the selected locale resources for labels and help controls', async () => {
    await renderWithLocale(30, 'de-CH');
    expect(screen.getByRole('radio', { name: /^Nass$/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^Feucht$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Über Feucht' })).toBeInTheDocument();
  });
});
