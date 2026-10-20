// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import enDevices from '../../../../public/locales/en/devices.json';
import enHistory from '../../../../public/locales/en/history.json';
import frDevices from '../../../../public/locales/fr/devices.json';
import frHistory from '../../../../public/locales/fr/history.json';
import type { Device, WatermarkChannelLatest } from '../../../types/farming';
import { DraginoTempCard } from '../DraginoTempCard';
import { Sdi12SoilCard } from '../Sdi12SoilCard';
import { SoilTensionReadings } from '../shared/SoilTensionReadings';

// The edge counterpart of the OSI Cloud SoilTensionCardParity test: the WATERMARK card
// (DraginoTempCard) and the Tensiomark card (Sdi12SoilCard) render one soil tension layout,
// with the same labels and states, so the two cards line up and match the cloud.

vi.mock('../../../services/api', () => ({
  devicesAPI: { remove: vi.fn().mockResolvedValue(undefined), rename: vi.fn() },
  sensorAPI: { getHistory: vi.fn().mockResolvedValue([]) },
}));

function i18n(lng: 'en' | 'fr' = 'en') {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    lng, fallbackLng: false, defaultNS: 'devices', ns: ['devices', 'history'],
    resources: {
      en: { devices: enDevices, history: enHistory },
      fr: { devices: frDevices, history: frHistory },
    },
    interpolation: { escapeValue: false }, react: { useSuspense: false }, initImmediate: false,
  });
  return instance;
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000 - 1_000).toISOString();

interface Fixture {
  /** Latest stored kPa per channel (1, 2); null is a missing value. */
  kpa?: [number | null, number | null];
  /** Depth per channel; null is unknown. */
  depths?: [number | null, number | null];
  lastSeen?: string;
}

const channel = (kpa: number | null, over: Partial<WatermarkChannelLatest> = {}): WatermarkChannelLatest => ({
  status: kpa === null ? null : 'ok', kpa, kpa_upper_bound: null, r_solved: null, r_upper_bound: null, offset_mv: null, ...over,
});

// A WATERMARK LSN50 with probes at 20 and 60 cm and one soil temperature (DS18B20).
function watermarkNode({ kpa = [12, 60.6], depths = [20, 60], lastSeen = minutesAgo(5) }: Fixture = {}): Device {
  const depthMap: Record<string, number> = {};
  depths.forEach((depth, index) => { if (depth !== null) depthMap[`swt_${index + 1}`] = depth; });
  return {
    deveui: 'TEST-EUI-NODE-A', name: 'Soil node A', type_id: 'DRAGINO_LSN50', last_seen: lastSeen,
    soil_moisture_probe_depths_json: depthMap,
    latest_data: {
      ext_temperature_c: 16.81,
      watermark: {
        recorded_at: lastSeen, supply_mv: 3300, soil_temp_c: 16.81, soil_temp_source: 2, die_temp_c: 21.5,
        channels: [channel(kpa[0]), channel(kpa[1])],
      },
    },
  } as Device;
}

// A Tensiomark SDI-12 node with two probes, listed deep-first so the depth sort shows.
function tensiomarkNode({ kpa = [12, 60.6], depths = [20, 60], lastSeen = minutesAgo(5) }: Fixture = {}): Device {
  return {
    deveui: 'TEST-EUI-NODE-B', name: 'Soil node B', type_id: 'DRAGINO_SDI12', last_seen: lastSeen,
    sdi12_probe_profile: 'TENSIOMARK', sdi12_probe_status: 'identified',
    sdi12_channel_layout_json: {
      version: 1, kind: 'tensiomark', source_unit: 'pF', field_order: 'temperature_pf', qualification: 'bench_observed',
      sensors: [
        { address: '4', channel: 2, identity: 'probe-two', depth_cm: depths[1], calibration_range: 'unverified' },
        { address: '1', channel: 1, identity: 'probe-one', depth_cm: depths[0], calibration_range: 'unverified' },
      ],
    },
    latest_data: { swt_1: kpa[0], soil_temp_1: 16.11, swt_2: kpa[1], soil_temp_2: 18.25 },
  } as Device;
}

type Family = 'watermark' | 'tensiomark';
const FAMILIES: Family[] = ['watermark', 'tensiomark'];

function renderFamily(family: Family, fixture: Fixture = {}, lng: 'en' | 'fr' = 'en') {
  const card = family === 'watermark'
    ? <DraginoTempCard removeContext="farm" device={watermarkNode(fixture)} />
    : <Sdi12SoilCard removeContext="farm" device={tensiomarkNode(fixture)} />;
  return render(<I18nextProvider i18n={i18n(lng)}>{card}</I18nextProvider>);
}

const readings = () => screen.getByTestId('soil-tension-readings');
const tiles = () => within(readings()).queryAllByTestId('soil-tension-tile');
const tile = (label: string) => screen.getByRole('group', { name: label });
const captions = () => tiles().map((element) => element.querySelector('p')?.textContent);
const statusOf = (element: HTMLElement) => element.querySelector('[data-swt-status]')?.getAttribute('data-swt-status') ?? null;

/** The class lists that decide how a card lines up in the device grid. */
function layoutSignature() {
  const section = readings();
  const grid = section.querySelector('[data-testid="soil-tension-grid"]') as HTMLElement;
  const firstTile = tiles()[0];
  return {
    section: section.className,
    grid: grid.className,
    tile: firstTile.className,
    label: (firstTile.querySelector('p') as HTMLElement).className,
    value: within(firstTile).getAllByRole('button')[0].className,
    tileCount: tiles().length,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('WATERMARK and Tensiomark cards share one soil tension layout', () => {
  it('renders the same section, grid, tile and value classes for both families', () => {
    renderFamily('watermark');
    const watermark = layoutSignature();
    cleanup();
    renderFamily('tensiomark');
    const tensiomark = layoutSignature();

    expect(tensiomark).toEqual(watermark);
    expect(watermark.tileCount).toBe(2);
    expect(watermark.grid).toContain('grid-cols-2');
    expect(watermark.value).toContain('text-2xl');
  });

  it.each(FAMILIES)('%s: names the section, the probe family and each probe by channel and depth', (family) => {
    renderFamily(family);
    const section = readings();
    expect(within(section).getByRole('heading', { name: 'Soil tension' })).toBeInTheDocument();
    expect(within(section).getByText(family === 'watermark' ? 'WATERMARK' : 'Tensiomark')).toBeInTheDocument();
    expect(captions()).toEqual(['Soil tension 1 (20 cm)', 'Soil tension 2 (60 cm)']);
    expect(within(tile('Soil tension 1 (20 cm)')).getByRole('button', { name: '12.0 kPa' })).toHaveAttribute('title', 'View history');
    expect(within(tile('Soil tension 2 (60 cm)')).getByRole('button', { name: '60.6 kPa' })).toBeInTheDocument();
  });

  it('shows no raw profile enum and no old value labels on the Tensiomark card', () => {
    renderFamily('tensiomark');
    expect(screen.queryByText('TENSIOMARK')).not.toBeInTheDocument();
    expect(screen.queryByText(/^SWT\b/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Soil temperature/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Address /)).not.toBeInTheDocument();
    expect(screen.getByText('SDI-12')).toBeInTheDocument();
    expect(screen.getByText('Identified')).toBeInTheDocument();
  });

  it('shows a Tensiomark soil temperature on each probe and the WATERMARK one on the first probe only', () => {
    renderFamily('tensiomark');
    expect(within(tile('Soil tension 1 (20 cm)')).getByRole('button', { name: 'Soil 16.1 °C' })).toBeInTheDocument();
    expect(within(tile('Soil tension 2 (60 cm)')).getByRole('button', { name: 'Soil 18.3 °C' })).toBeInTheDocument();
    cleanup();
    renderFamily('watermark');
    expect(within(tile('Soil tension 1 (20 cm)')).getByRole('button', { name: 'Soil 16.8 °C' })).toBeInTheDocument();
    expect(within(tile('Soil tension 2 (60 cm)')).queryByText(/°C/)).not.toBeInTheDocument();
  });

  it.each(FAMILIES)('%s: translates every label (French)', (family) => {
    renderFamily(family, {}, 'fr');
    const section = readings();
    expect(within(section).getByRole('heading', { name: "Tension de l'eau du sol" })).toBeInTheDocument();
    expect(within(tile('Tension du sol 1 (20 cm)')).getByRole('button', { name: '12.0 kPa' })).toHaveAttribute('title', "Voir l'historique");
    expect(within(tile('Tension du sol 1 (20 cm)')).getByRole('button', { name: /^Sol 16[.,]\d °C$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "Paramètres de l'appareil" })).toBeInTheDocument();
    expect(screen.getByText(/Vu il y a 5 minutes/)).toBeInTheDocument();
    expect(screen.queryByText(/Soil tension|Soil temperature|^SWT\b|Last seen|minutes ago/)).not.toBeInTheDocument();
  });

  it.each(FAMILIES)('%s: gives each probe its own pill on the latest stored value', (family) => {
    renderFamily(family, { kpa: [12, 35] });
    expect(statusOf(tile('Soil tension 1 (20 cm)'))).toBe('wet');
    expect(statusOf(tile('Soil tension 2 (60 cm)'))).toBe('moist');
  });

  it.each(FAMILIES)('%s: keeps value and pill on a five-day-old reading and puts the age on the last-seen line', (family) => {
    renderFamily(family, { lastSeen: minutesAgo(5 * 24 * 60) });
    expect(within(tile('Soil tension 2 (60 cm)')).getByRole('button', { name: '60.6 kPa' })).toBeInTheDocument();
    expect(statusOf(tile('Soil tension 2 (60 cm)'))).toBe('dry');
    expect(screen.getByText(/Last seen: 5 days ago/)).toBeInTheDocument();
  });

  it.each(FAMILIES)('%s: shows a missing value as an empty tile with no pill and no history link', (family) => {
    renderFamily(family, { kpa: [12, null] });
    const empty = tile('Soil tension 2 (60 cm)');
    expect(empty).toHaveTextContent('—');
    expect(statusOf(empty)).toBeNull();
    expect(within(empty).queryByRole('button', { name: /kPa|pF/ })).not.toBeInTheDocument();
    expect(within(empty).queryByText('Invalid reading')).not.toBeInTheDocument();
  });

  it.each(FAMILIES)('%s: marks a value outside the displayable range as invalid, with no pill', (family) => {
    renderFamily(family, { kpa: [12, 1_000_001] });
    const invalid = tile('Soil tension 2 (60 cm)');
    expect(invalid).toHaveTextContent('—');
    expect(within(invalid).getByText('Invalid reading')).toBeInTheDocument();
    expect(statusOf(invalid)).toBeNull();
    expect(within(invalid).queryByRole('button', { name: /kPa|pF/ })).not.toBeInTheDocument();
  });

  it.each(FAMILIES)('%s: follows the pF display preference and keeps 0 kPa in kPa with a Wet pill', (family) => {
    window.localStorage.setItem('osi.display.swtUnit', 'pF');
    renderFamily(family, { kpa: [0, 60.6] });
    expect(within(tile('Soil tension 1 (20 cm)')).getByRole('button', { name: '0.0 kPa' })).toBeInTheDocument();
    expect(statusOf(tile('Soil tension 1 (20 cm)'))).toBe('wet');
    // pF = log10(kPa * 10): log10(606) = 2.78
    expect(within(tile('Soil tension 2 (60 cm)')).getByRole('button', { name: '2.78 pF' })).toBeInTheDocument();
  });

  it.each(FAMILIES)('%s: leaves the depth out of the label when it is unknown and sorts that probe last', (family) => {
    renderFamily(family, { depths: [null, 60] });
    expect(captions()).toEqual(['Soil tension 2 (60 cm)', 'Soil tension 1']);
  });

  it('shows the shared empty state on a Tensiomark card without probes or readings', () => {
    render(
      <I18nextProvider i18n={i18n()}>
        <Sdi12SoilCard removeContext="farm" device={{ ...tensiomarkNode(), sdi12_channel_layout_json: null, latest_data: {} }} />
      </I18nextProvider>,
    );
    expect(within(readings()).getByText('No soil readings available.')).toBeInTheDocument();
    expect(tiles()).toHaveLength(0);
  });

  it('keeps the gateway-only WATERMARK probe diagnosis under a missing value', () => {
    const device = watermarkNode();
    const watermark = device.latest_data!.watermark!;
    watermark.channels = [channel(12), channel(null, { status: 'calibration_required' })];
    render(<I18nextProvider i18n={i18n()}><DraginoTempCard removeContext="farm" device={device} /></I18nextProvider>);
    const probe = tile('Soil tension 2 (60 cm)');
    expect(probe).toHaveTextContent('—');
    expect(within(probe).getByText('Calibration needed')).toBeInTheDocument();
    expect(statusOf(probe)).toBeNull();
  });
});

describe('SoilTensionReadings', () => {
  it('opens the history callbacks of the value and the secondary line', () => {
    const onValue = vi.fn();
    const onSecondary = vi.fn();
    render(
      <I18nextProvider i18n={i18n()}>
        <SoilTensionReadings
          family="Tensiomark"
          probes={[{ channel: 1, depthCm: 30, kpa: 25, onOpenHistory: onValue, secondary: { text: 'Soil 15.0 °C', onOpenHistory: onSecondary } }]}
        />
      </I18nextProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '25.0 kPa' }));
    fireEvent.click(screen.getByRole('button', { name: 'Soil 15.0 °C' }));
    expect(onValue).toHaveBeenCalledTimes(1);
    expect(onSecondary).toHaveBeenCalledTimes(1);
  });

  it('shows a value without a history link as plain text, never as a button', () => {
    render(
      <I18nextProvider i18n={i18n()}>
        <SoilTensionReadings family="WATERMARK" probes={[{ channel: 1, depthCm: null, kpa: 25 }]} />
      </I18nextProvider>,
    );
    expect(within(tile('Soil tension 1')).getByText('25.0 kPa')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
