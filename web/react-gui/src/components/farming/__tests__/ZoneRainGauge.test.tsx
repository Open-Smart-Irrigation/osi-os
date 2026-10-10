// @vitest-environment jsdom
//
// Choosing a zone's rain gauge (rain correctness R-ZSEL, owner decision D1):
// the zone settings list the zone's gauges with the field journal's pick
// marked as a suggestion, the choice is saved with the other settings, and
// the zone's water card says when two gauges report and none is chosen
// (its place in the card: IrrigationZoneCardData.test.tsx).
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import { ZoneConfigModal } from '../ZoneConfigModal';
import { RainGaugeAmbiguityBanner } from '../environment/RainGaugeAmbiguityBanner';
import { irrigationZonesAPI, zoneRainSourceAPI } from '../../../services/api';
import { normaliseZoneRainSource } from '../../../utils/zoneRainSource';
import type { IrrigationZone } from '../../../types/farming';

import enDevices from '../../../../public/locales/en/devices.json';
import enCommon from '../../../../public/locales/en/common.json';
import frDevices from '../../../../public/locales/fr/devices.json';
import frCommon from '../../../../public/locales/fr/common.json';

vi.mock('../../../services/deviceLocation', () => ({
  getDeviceLocationErrorMessage: vi.fn(() => 'Location unavailable'),
  getDeviceLocationSupport: vi.fn().mockResolvedValue({
    available: false, reason: 'unsupported', message: 'Device GPS unavailable in tests',
    permissionState: 'unknown', canOpenSettings: false,
  }),
  openNativeLocationSettings: vi.fn(() => false),
  requestDeviceLocation: vi.fn(),
}));

vi.mock('../../../services/api', () => ({
  irrigationZonesAPI: {
    updateConfig: vi.fn().mockResolvedValue({}),
    updateCalibration: vi.fn().mockResolvedValue(undefined),
    setZoneLocation: vi.fn().mockResolvedValue(undefined),
  },
  zoneRainSourceAPI: {
    get: vi.fn(),
    set: vi.fn(),
  },
  zoneExportAPI: { download: vi.fn().mockResolvedValue(undefined) },
}));

const GAUGE = 'A840410000000001';
const STATION = 'A840410000000002';

const AMBIGUOUS = normaliseZoneRainSource({
  state: 'ambiguous', selected_deveui: null, basis: null,
  candidates: [
    { deveui: GAUGE, name: 'Gauge north', type_id: 'AQUASCOPE_LORAIN', via: 'direct' },
    { deveui: STATION, name: 'Station east', type_id: 'SENSECAP_S2120', via: 'weather_station' },
  ],
  suggested_deveui: GAUGE,
});
const EXPLICIT = { ...AMBIGUOUS, state: 'selected' as const, selectedDeveui: STATION, basis: 'explicit' as const, suggestedDeveui: null };

const zone: IrrigationZone = {
  id: 42, name: 'North Block', device_count: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  schedule: null, measuredFlowRateLpm: null, measurementMethod: null,
};

async function i18n(language = 'en') {
  const instance = i18next.createInstance();
  await instance.use(initReactI18next).init({
    lng: language, fallbackLng: 'en', ns: ['devices', 'common'], defaultNS: 'devices',
    interpolation: { escapeValue: false }, react: { useSuspense: false },
    resources: { en: { devices: enDevices, common: enCommon }, fr: { devices: frDevices, common: frCommon } },
  });
  return instance;
}

async function renderModal(language = 'en') {
  const instance = await i18n(language);
  return render(
    <I18nextProvider i18n={instance}>
      <ZoneConfigModal isOpen zone={zone} onClose={vi.fn()} onSaved={vi.fn()} />
    </I18nextProvider>,
  );
}

const rainSelect = () => screen.getByLabelText('Rain gauge for this zone') as HTMLSelectElement;

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe('zone settings: rain gauge for this zone', () => {
  it('lists the gauges with the suggestion marked and nothing chosen while the zone is ambiguous', async () => {
    vi.mocked(zoneRainSourceAPI.get).mockResolvedValue(AMBIGUOUS);
    await renderModal();
    await waitFor(() => expect(rainSelect()).toBeInTheDocument());
    expect(zoneRainSourceAPI.get).toHaveBeenCalledWith(42);
    const options = Array.from(rainSelect().options).map((o) => [o.value, o.textContent]);
    expect(options).toEqual([
      ['', '— No gauge chosen —'],
      [GAUGE, 'Gauge north — suggested'],
      [STATION, 'Station east (shared weather station)'],
    ]);
    expect(rainSelect().value).toBe('');
    expect(screen.getByText('Two rain gauges report for this zone. Until you choose one, the zone has no measured rain.')).toBeInTheDocument();
  });

  it('saves a chosen gauge with the settings', async () => {
    vi.mocked(zoneRainSourceAPI.get).mockResolvedValue(AMBIGUOUS);
    vi.mocked(zoneRainSourceAPI.set).mockResolvedValue(EXPLICIT);
    await renderModal();
    await waitFor(() => expect(rainSelect()).toBeInTheDocument());
    fireEvent.change(rainSelect(), { target: { value: STATION } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(zoneRainSourceAPI.set).toHaveBeenCalledWith(42, STATION));
    expect(irrigationZonesAPI.updateConfig).not.toHaveBeenCalled();
  });

  it('does not write the gauge when the choice is unchanged, and never confirms the suggestion by itself', async () => {
    vi.mocked(zoneRainSourceAPI.get).mockResolvedValue(AMBIGUOUS);
    await renderModal();
    await waitFor(() => expect(rainSelect()).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Rows 1 to 4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(irrigationZonesAPI.updateConfig).toHaveBeenCalled());
    expect(zoneRainSourceAPI.set).not.toHaveBeenCalled();
  });

  it('shows an explicit choice and clears it with null', async () => {
    vi.mocked(zoneRainSourceAPI.get).mockResolvedValue(EXPLICIT);
    vi.mocked(zoneRainSourceAPI.set).mockResolvedValue(AMBIGUOUS);
    await renderModal();
    await waitFor(() => expect(rainSelect().value).toBe(STATION));
    expect(screen.queryByText(/Two rain gauges report for this zone/)).not.toBeInTheDocument();
    fireEvent.change(rainSelect(), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(zoneRainSourceAPI.set).toHaveBeenCalledWith(42, null));
  });

  it('says so when the only gauge is used, and hides the field for a zone without a gauge', async () => {
    vi.mocked(zoneRainSourceAPI.get).mockResolvedValue({
      state: 'selected', selectedDeveui: GAUGE, basis: 'only_candidate', suggestedDeveui: null,
      candidates: [AMBIGUOUS.candidates[0]],
    });
    await renderModal();
    expect(await screen.findByText('The only rain gauge of this zone is used.')).toBeInTheDocument();
    cleanup();
    vi.mocked(zoneRainSourceAPI.get).mockResolvedValue(normaliseZoneRainSource({ state: 'none', candidates: [] }));
    await renderModal();
    await waitFor(() => expect(zoneRainSourceAPI.get).toHaveBeenCalledTimes(2));
    expect(screen.queryByLabelText('Rain gauge for this zone')).not.toBeInTheDocument();
  });

  it('reports a failed load without blocking the other settings', async () => {
    vi.mocked(zoneRainSourceAPI.get).mockRejectedValue(new Error('offline'));
    await renderModal();
    expect(await screen.findByText('The rain gauges of this zone could not be loaded.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Still saves' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(irrigationZonesAPI.updateConfig).toHaveBeenCalled());
    expect(zoneRainSourceAPI.set).not.toHaveBeenCalled();
  });

  it('renders in the farm language', async () => {
    vi.mocked(zoneRainSourceAPI.get).mockResolvedValue(AMBIGUOUS);
    await renderModal('fr');
    expect(await screen.findByLabelText('Pluviomètre de cette zone')).toBeInTheDocument();
  });
});

describe('zone water card: two gauges and no choice', () => {
  async function renderBanner(zoneId = 42) {
    const instance = await i18n();
    return render(<I18nextProvider i18n={instance}><RainGaugeAmbiguityBanner zoneId={zoneId} /></I18nextProvider>);
  }
  const BANNER = 'Two rain gauges report for this zone. Choose one in the zone settings.';

  it('shows the banner while the zone is ambiguous', async () => {
    vi.mocked(zoneRainSourceAPI.get).mockResolvedValue(AMBIGUOUS);
    await renderBanner();
    expect(await screen.findByRole('status')).toHaveTextContent(BANNER);
  });

  it('shows nothing once a gauge is chosen, or when the selection cannot be read', async () => {
    vi.mocked(zoneRainSourceAPI.get).mockResolvedValue(EXPLICIT);
    await renderBanner();
    await waitFor(() => expect(zoneRainSourceAPI.get).toHaveBeenCalledWith(42));
    expect(screen.queryByText(BANNER)).not.toBeInTheDocument();
    cleanup();
    vi.mocked(zoneRainSourceAPI.get).mockRejectedValue(new Error('offline'));
    await renderBanner();
    await waitFor(() => expect(zoneRainSourceAPI.get).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(BANNER)).not.toBeInTheDocument();
  });

  it('reads the selection again when its refresh key changes (a saved choice)', async () => {
    vi.mocked(zoneRainSourceAPI.get).mockResolvedValueOnce(AMBIGUOUS).mockResolvedValueOnce(EXPLICIT);
    const instance = await i18n();
    const view = (key: number) => (
      <I18nextProvider i18n={instance}><RainGaugeAmbiguityBanner zoneId={42} refreshKey={key} /></I18nextProvider>
    );
    const { rerender } = render(view(0));
    expect(await screen.findByText(BANNER)).toBeInTheDocument();
    rerender(view(1));
    await waitFor(() => expect(screen.queryByText(BANNER)).not.toBeInTheDocument());
    expect(zoneRainSourceAPI.get).toHaveBeenCalledTimes(2);
  });
});
