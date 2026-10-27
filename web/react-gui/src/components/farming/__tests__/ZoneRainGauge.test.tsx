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

async function renderModal(
  language = 'en',
  callbacks = { onClose: vi.fn(), onSaved: vi.fn() },
) {
  const instance = await i18n(language);
  return render(
    <I18nextProvider i18n={instance}>
      <ZoneConfigModal isOpen zone={zone} onClose={callbacks.onClose} onSaved={callbacks.onSaved} />
    </I18nextProvider>,
  );
}

const rainSelect = () => screen.getByLabelText('Rain gauge for this zone') as HTMLSelectElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(irrigationZonesAPI.updateConfig).mockReset().mockResolvedValue(zone);
  vi.mocked(irrigationZonesAPI.updateCalibration).mockReset().mockResolvedValue(undefined);
  vi.mocked(irrigationZonesAPI.setZoneLocation).mockReset().mockResolvedValue(undefined);
  vi.mocked(zoneRainSourceAPI.set).mockReset().mockResolvedValue(EXPLICIT);
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

  it('names the automatically used only gauge without making it an explicit choice', async () => {
    vi.mocked(zoneRainSourceAPI.get).mockResolvedValue({
      state: 'selected', selectedDeveui: GAUGE, basis: 'only_candidate', suggestedDeveui: null,
      candidates: [AMBIGUOUS.candidates[0]],
    });
    await renderModal();
    const select = await screen.findByLabelText('Rain gauge for this zone') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(Array.from(select.options).map((option) => [option.value, option.textContent])).toEqual([
      ['', 'Automatic: Gauge north'],
      [GAUGE, 'Gauge north'],
    ]);
    expect(await screen.findByText('Automatically using Gauge north, the only rain gauge for this zone.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledTimes(0));
    expect(zoneRainSourceAPI.set).not.toHaveBeenCalled();
  });

  it('hides the rain field for a zone without a gauge', async () => {
    cleanup();
    vi.mocked(zoneRainSourceAPI.get).mockResolvedValue(normaliseZoneRainSource({ state: 'none', candidates: [] }));
    await renderModal();
    await waitFor(() => expect(zoneRainSourceAPI.get).toHaveBeenCalledTimes(1));
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

  it('reports a partial save and retries only the failed rain choice', async () => {
    vi.mocked(zoneRainSourceAPI.get).mockResolvedValue(AMBIGUOUS);
    vi.mocked(zoneRainSourceAPI.set)
      .mockRejectedValueOnce(new Error('rain endpoint unavailable'))
      .mockResolvedValueOnce(EXPLICIT);
    const callbacks = { onClose: vi.fn(), onSaved: vi.fn() };
    await renderModal('en', callbacks);
    await waitFor(() => expect(rainSelect()).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'First note' } });
    fireEvent.change(rainSelect(), { target: { value: STATION } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Rain gauge choice was not saved. Review the selection and retry Save.')).toBeInTheDocument();
    expect(screen.getByText('Saved: Zone settings')).toBeInTheDocument();
    expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledTimes(1);
    expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledWith(42, { notes: 'First note' });
    expect(zoneRainSourceAPI.set).toHaveBeenNthCalledWith(1, 42, STATION);
    expect(rainSelect().value).toBe(STATION);
    expect(callbacks.onSaved).not.toHaveBeenCalled();
    expect(callbacks.onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(callbacks.onSaved).toHaveBeenCalledTimes(1));
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);
    expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledTimes(1);
    expect(zoneRainSourceAPI.set).toHaveBeenCalledTimes(2);
    expect(zoneRainSourceAPI.set).toHaveBeenNthCalledWith(2, 42, STATION);
  });

  it('resends a successful stage when its form payload changes before retry', async () => {
    vi.mocked(zoneRainSourceAPI.get).mockResolvedValue(AMBIGUOUS);
    vi.mocked(zoneRainSourceAPI.set)
      .mockRejectedValueOnce(new Error('rain endpoint unavailable'))
      .mockResolvedValueOnce(EXPLICIT);
    await renderModal();
    await waitFor(() => expect(rainSelect()).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'First note' } });
    fireEvent.change(rainSelect(), { target: { value: STATION } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved: Zone settings')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Updated note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(zoneRainSourceAPI.set).toHaveBeenCalledTimes(2));
    expect(irrigationZonesAPI.updateConfig).toHaveBeenNthCalledWith(1, 42, { notes: 'First note' });
    expect(irrigationZonesAPI.updateConfig).toHaveBeenNthCalledWith(2, 42, { notes: 'Updated note' });
  });

  it('shows no saved-stage list when only the rain choice fails', async () => {
    vi.mocked(zoneRainSourceAPI.get).mockResolvedValue(AMBIGUOUS);
    vi.mocked(zoneRainSourceAPI.set).mockRejectedValue(new Error('rain endpoint unavailable'));
    await renderModal();
    await waitFor(() => expect(rainSelect()).toBeInTheDocument());
    fireEvent.change(rainSelect(), { target: { value: STATION } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Rain gauge choice was not saved. Review the selection and retry Save.')).toBeInTheDocument();
    expect(screen.queryByText(/^Saved:/)).not.toBeInTheDocument();
  });

  it('does not claim config saved or write rain when config fails first', async () => {
    vi.mocked(zoneRainSourceAPI.get).mockResolvedValue(AMBIGUOUS);
    vi.mocked(irrigationZonesAPI.updateConfig).mockRejectedValue(new Error('config endpoint unavailable'));
    await renderModal();
    await waitFor(() => expect(rainSelect()).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'First note' } });
    fireEvent.change(rainSelect(), { target: { value: STATION } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('config endpoint unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/^Saved:/)).not.toBeInTheDocument();
    expect(screen.queryByText('Rain gauge choice was not saved. Review the selection and retry Save.')).not.toBeInTheDocument();
    expect(zoneRainSourceAPI.set).not.toHaveBeenCalled();
  });

  it('lists calibration and location when both stages resolve before rain fails', async () => {
    vi.mocked(zoneRainSourceAPI.get).mockResolvedValue(AMBIGUOUS);
    vi.mocked(zoneRainSourceAPI.set).mockRejectedValue(new Error('rain endpoint unavailable'));
    await renderModal();
    await waitFor(() => expect(rainSelect()).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Flow rate (L/min)'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Latitude'), { target: { value: '46.5' } });
    fireEvent.change(screen.getByLabelText('Longitude'), { target: { value: '6.6' } });
    fireEvent.change(rainSelect(), { target: { value: STATION } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Saved: Irrigation calibration, Zone location')).toBeInTheDocument();
    expect(irrigationZonesAPI.updateCalibration).toHaveBeenCalledWith(42, {
      measuredFlowRateLpm: 5, measurementMethod: null,
    });
    expect(irrigationZonesAPI.setZoneLocation).toHaveBeenCalledWith(42, { latitude: 46.5, longitude: 6.6 });
  });

  it('stops after calibration rejects and does not report that stage as saved', async () => {
    vi.mocked(zoneRainSourceAPI.get).mockResolvedValue(AMBIGUOUS);
    vi.mocked(irrigationZonesAPI.updateCalibration).mockRejectedValue(new Error('calibration endpoint unavailable'));
    await renderModal();
    await waitFor(() => expect(rainSelect()).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Flow rate (L/min)'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Latitude'), { target: { value: '46.5' } });
    fireEvent.change(screen.getByLabelText('Longitude'), { target: { value: '6.6' } });
    fireEvent.change(rainSelect(), { target: { value: STATION } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('calibration endpoint unavailable')).toBeInTheDocument();
    expect(irrigationZonesAPI.setZoneLocation).not.toHaveBeenCalled();
    expect(zoneRainSourceAPI.set).not.toHaveBeenCalled();
    expect(screen.queryByText(/^Saved:/)).not.toBeInTheDocument();
  });

  it('keeps the general error path when location rejects before rain', async () => {
    vi.mocked(zoneRainSourceAPI.get).mockResolvedValue(AMBIGUOUS);
    vi.mocked(irrigationZonesAPI.setZoneLocation).mockRejectedValue(new Error('location endpoint unavailable'));
    await renderModal();
    await waitFor(() => expect(rainSelect()).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Flow rate (L/min)'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Latitude'), { target: { value: '46.5' } });
    fireEvent.change(screen.getByLabelText('Longitude'), { target: { value: '6.6' } });
    fireEvent.change(rainSelect(), { target: { value: STATION } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('location endpoint unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/^Saved:/)).not.toBeInTheDocument();
    expect(zoneRainSourceAPI.set).not.toHaveBeenCalled();
  });
});

describe('zone water card: two gauges and no choice', () => {
  async function renderBanner(zoneId = 42, canWrite = true) {
    const instance = await i18n();
    return render(<I18nextProvider i18n={instance}><RainGaugeAmbiguityBanner zoneId={zoneId} canWrite={canWrite} /></I18nextProvider>);
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
      <I18nextProvider i18n={instance}><RainGaugeAmbiguityBanner zoneId={42} canWrite refreshKey={key} /></I18nextProvider>
    );
    const { rerender } = render(view(0));
    expect(await screen.findByText(BANNER)).toBeInTheDocument();
    rerender(view(1));
    await waitFor(() => expect(screen.queryByText(BANNER)).not.toBeInTheDocument());
    expect(zoneRainSourceAPI.get).toHaveBeenCalledTimes(2);
  });
});
