import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';
import en from '../../../../public/locales/en/history.json';
import de from '../../../../public/locales/de-CH/history.json';
import fr from '../../../../public/locales/fr/history.json';
import itHistory from '../../../../public/locales/it/history.json';
import es from '../../../../public/locales/es/history.json';
import pt from '../../../../public/locales/pt/history.json';
import lg from '../../../../public/locales/lg/history.json';
import { SwtStatusIndicator } from '../shared/SwtStatusIndicator';
import type { SwtWaterStatus } from '../../../utils/swt';

afterEach(cleanup);

async function renderIndicator(status: SwtWaterStatus | null, language = 'en') {
  const instance = i18next.createInstance();
  await instance.use(initReactI18next).init({
    lng: language, fallbackLng: false, ns: ['history'], defaultNS: 'history',
    resources: { en: { history: en }, 'de-CH': { history: de }, fr: { history: fr },
      it: { history: itHistory }, es: { history: es }, pt: { history: pt }, lg: { history: lg } },
    interpolation: { escapeValue: false },
  });
  return { instance, ...render(<I18nextProvider i18n={instance}><SwtStatusIndicator status={status} /></I18nextProvider>) };
}

describe('SwtStatusIndicator', () => {
  it('keeps the status readable without color, a live region, or a second control', async () => {
    const view = await renderIndicator('wet');
    const badge = screen.getByText('Wet');
    expect(badge).toHaveAttribute('data-swt-status', 'wet');
    expect(badge.style.backgroundColor).toBe('var(--soil-wet-bg)');
    expect(badge.style.borderColor).toBe('var(--soil-wet)');
    expect(badge).toHaveClass('text-[var(--text)]', 'shrink-0', 'whitespace-nowrap');
    expect(badge).not.toHaveAttribute('role', 'status');
    expect(badge).not.toHaveAttribute('tabindex');
    expect(badge.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
    expect(view.container.querySelector('button')).toBeNull();
  });

  it.each([
    ['en', ['Wet', 'Moist', 'Dry']], ['de-CH', ['Nass', 'Feucht', 'Trocken']],
    ['fr', ['Saturé', 'Humide', 'Sec']], ['it', ['Bagnato', 'Umido', 'Secco']],
    ['es', ['Mojado', 'Húmedo', 'Seco']], ['pt', ['Molhado', 'Húmido', 'Seco']],
    ['lg', ['Kitose', 'Kitosetose', 'Kikalu']],
  ] as const)('renders all three labels from the real %s resource without fallback', async (language, expected) => {
    for (const [index, status] of (['wet', 'moist', 'dry'] as const).entries()) {
      const view = await renderIndicator(status, language);
      expect(screen.getByText(expected[index])).toBeInTheDocument();
      view.unmount();
    }
  });

  it('updates its label when the user switches language', async () => {
    const { instance } = await renderIndicator('moist');
    await act(() => instance.changeLanguage('de-CH'));
    expect(screen.getByText('Feucht')).toBeInTheDocument();
    expect(screen.queryByText('Moist')).not.toBeInTheDocument();
  });

  it('renders nothing without a valid status', async () => {
    expect((await renderIndicator(null)).container).toBeEmptyDOMElement();
  });
});
