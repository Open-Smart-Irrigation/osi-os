// @vitest-environment jsdom
//
// F100/X-16 and X-10 (overnight 2026-09-17, T13m): `display.fallbackReason`
// is still plain English from the edge's zone-env-fn flow node, and the
// cloud's own linked bundle can populate the same field with prose of its
// own; EnvironmentCard used to print it verbatim. Separately, the card's own
// load-failure banner passed a raw `err.response.data.message` (or axios's
// generic English `err.message`) straight to screen — the `data?.message`
// passthrough X-10 calls out, scoped here to the water/environment card.
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import i18next, { type i18n as I18n } from 'i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EnvironmentCard } from '../environment/EnvironmentCard';
import type { Device, IrrigationZone, ZoneEnvironmentSummary } from '../../../types/farming';

import enDevices from '../../../../public/locales/en/devices.json';
import frDevices from '../../../../public/locales/fr/devices.json';

const apiMocks = vi.hoisted(() => ({ getSummary: vi.fn() }));

vi.mock('../../../services/api', () => ({
  environmentAPI: { getSummary: apiMocks.getSummary },
}));

const zone = { id: 12, name: 'Zone B' } as unknown as IrrigationZone;
const devices: Device[] = [];

const baseSummary = {
  zoneId: 12,
  zoneName: 'Zone B',
  generatedAt: '2026-07-08T10:00:00.000Z',
  location: { source: 'unavailable', latitude: null, longitude: null, timezone: 'UTC' },
  water: {
    available: false,
    observedAt: null,
    action: null,
    daily: [],
    sensorHealth: { sensorCount: 0, freshSensorCount: 0, staleSensorCount: 0, rainGaugePresent: false, flowMeterPresent: false, warnings: [] },
  },
  local: {},
  online: { available: false, cacheStatus: 'miss' },
  agronomic: {},
  forecast: { available: false },
  display: { mode: 'unlinked_local', schedulingMode: 'local', sourceLabel: 'Local only', sharedGeneratedAt: null, sharedObservedAt: null, lastReceivedAt: null, fallbackReason: null },
  drift: null,
} as unknown as ZoneEnvironmentSummary;

async function buildI18n(language: string): Promise<I18n> {
  const instance = i18next.createInstance();
  await instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    ns: ['devices'],
    defaultNS: 'devices',
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    resources: { en: { devices: enDevices }, fr: { devices: frDevices } },
  });
  return instance;
}

async function renderExpanded(language: string) {
  const instance = await buildI18n(language);
  render(
    <I18nextProvider i18n={instance}>
      <EnvironmentCard zone={zone} devices={devices} />
    </I18nextProvider>,
  );
  fireEvent.click(screen.getByRole('button', { expanded: false }));
}

beforeEach(() => {
  apiMocks.getSummary.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('EnvironmentCard fallbackReason honesty (F100/X-16)', () => {
  it('maps the flow node\'s known English fallbackReason sentences to translated keys', async () => {
    apiMocks.getSummary.mockResolvedValue({
      ...baseSummary,
      display: { ...baseSummary.display, fallbackReason: 'Using local fallback because the OSI Server bundle is unavailable.' },
    });
    await renderExpanded('fr');
    await waitFor(() => expect(apiMocks.getSummary).toHaveBeenCalled());

    expect(await screen.findByText(frDevices.zone.water.source.bundle_unavailable)).toBeInTheDocument();
    expect(screen.queryByText('Using local fallback because the OSI Server bundle is unavailable.')).not.toBeInTheDocument();
  });

  it('falls back to the generic source key for an unmapped fallbackReason sentence', async () => {
    apiMocks.getSummary.mockResolvedValue({
      ...baseSummary,
      display: { ...baseSummary.display, fallbackReason: 'A brand new banner the flow node does not emit yet.' },
    });
    await renderExpanded('fr');
    await waitFor(() => expect(apiMocks.getSummary).toHaveBeenCalled());

    expect(await screen.findByText(frDevices.zone.water.source.fallback_generic)).toBeInTheDocument();
    expect(screen.queryByText('A brand new banner the flow node does not emit yet.')).not.toBeInTheDocument();
  });
});

describe('EnvironmentCard load-failure honesty (X-10)', () => {
  it('never renders the backend\'s data.message prose', async () => {
    apiMocks.getSummary.mockRejectedValue({
      response: { status: 500, data: { message: 'Zone environment summary query threw a SQLITE_BUSY exception at line 214.' } },
    });
    await renderExpanded('fr');

    const banner = await screen.findByText(new RegExp(frDevices.environment.loadFailed));
    expect(banner).toBeInTheDocument();
    expect(screen.queryByText(/SQLITE_BUSY/)).not.toBeInTheDocument();
    // The HTTP status is a code, not prose, so it may still appear.
    expect(banner).toHaveTextContent('500');
  });

  it('never renders axios\'s own generic English error message', async () => {
    apiMocks.getSummary.mockRejectedValue({ message: 'Request failed with status code 404' });
    await renderExpanded('fr');

    const banner = await screen.findByText(new RegExp(frDevices.environment.loadFailed));
    expect(banner).toBeInTheDocument();
    expect(screen.queryByText(/Request failed/)).not.toBeInTheDocument();
  });
});
