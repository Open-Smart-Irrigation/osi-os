// @vitest-environment jsdom
//
// F59 (overnight 2026-09-17): the Silvan UI harness reported "Gateway",
// "Zoom in" and "Zoom out" rendering in English on a French session and
// attributed them to `history.cardType.gateway` / `history.desktop.zoomIn` /
// `zoomOut`, because it reverse-matched the rendered English against the `en`
// bundle. Those keys are not the source. The zoom strings come from Leaflet's
// own zoom control, whose `zoomInTitle`/`zoomOutTitle` options default to the
// English literals and which NetworkPage mounted with those defaults.
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { Control } from 'leaflet';
import { NetworkPage } from '../NetworkPage';
import enHistory from '../../../public/locales/en/history.json';
import enNetwork from '../../../public/locales/en/network.json';
import frHistory from '../../../public/locales/fr/history.json';
import frNetwork from '../../../public/locales/fr/network.json';

const mocks = vi.hoisted(() => ({
  getAll: vi.fn(), location: vi.fn(), radio: vi.fn(), observations: vi.fn(),
  saveLocation: vi.fn(), saveRadio: vi.fn(),
}));
vi.mock('../../services/api', () => ({
  devicesAPI: { getAll: mocks.getAll },
  networkAPI: {
    location: mocks.location, radio: mocks.radio, observations: mocks.observations,
    saveLocation: mocks.saveLocation, saveRadio: mocks.saveRadio,
  },
}));

async function frenchI18n() {
  const instance = i18next.createInstance();
  await instance.use(initReactI18next).init({
    lng: 'fr',
    fallbackLng: 'en',
    ns: ['network', 'history'],
    defaultNS: 'network',
    resources: {
      en: { network: enNetwork, history: enHistory },
      fr: { network: frNetwork, history: frHistory },
    },
    interpolation: { escapeValue: false },
  });
  return instance;
}

const device = { deveui: 'ABCDEF0123456789', name: 'Gateway radio', type_id: 'KIWI_SENSOR' } as any;
const emptyPage = { rows: [], truncated: false, nextOffset: null, from: '', to: '' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('crypto', { randomUUID: () => '11111111-1111-4111-8111-111111111111' });
  mocks.getAll.mockResolvedValue([device]);
  mocks.location.mockResolvedValue(null);
  mocks.radio.mockResolvedValue(null);
  mocks.observations.mockResolvedValue(emptyPage);
});

describe('network map zoom controls under a French session', () => {
  it('is Leaflet, not the history bundle, that supplies the English zoom labels', async () => {
    // Root-cause pin: Leaflet ships these English literals as control defaults,
    // so a map mounted without explicit titles renders English in every locale.
    expect(Control.Zoom.prototype.options.zoomInTitle).toBe('Zoom in');
    expect(Control.Zoom.prototype.options.zoomOutTitle).toBe('Zoom out');

    // Counter-evidence for the reported hypothesis: the French history bundle
    // resolves the keys the harness named, so namespace/bundle resolution is
    // not the defect.
    const i18n = await frenchI18n();
    expect(i18n.t('history:history.cardType.gateway')).toBe('Passerelle');
    expect(i18n.t('history:history.desktop.zoomIn')).toBe('Zoom avant');
    expect(i18n.t('history:history.desktop.zoomOut')).toBe('Zoom arrière');
  });

  it('labels the map zoom buttons in the active language', async () => {
    const i18n = await frenchI18n();
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter><NetworkPage /></MemoryRouter>
      </I18nextProvider>,
    );
    await screen.findByRole('heading', { name: 'Observations réseau', level: 1 });

    const zoomIn = await waitFor(() => {
      const found = container.querySelector('.leaflet-control-zoom-in');
      if (!found) throw new Error('zoom-in control not rendered');
      return found;
    });
    const zoomOut = container.querySelector('.leaflet-control-zoom-out');

    expect(zoomIn.getAttribute('title')).toBe('Zoom avant');
    expect(zoomIn.getAttribute('aria-label')).toBe('Zoom avant');
    expect(zoomOut?.getAttribute('title')).toBe('Zoom arrière');
    expect(zoomOut?.getAttribute('aria-label')).toBe('Zoom arrière');
  });
});
