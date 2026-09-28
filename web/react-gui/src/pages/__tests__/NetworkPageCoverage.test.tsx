// @vitest-environment jsdom
//
// The coverage walk of 2026-09-25: a RAK10701 field tester is carried around
// the farm, each uplink is captured as a radio observation, and this page is
// what the operator reads while walking. The export is the handoff to
// osi-planner, which draws the measured points over the terrain-predicted
// coverage — so the GeoJSON shape here is an interface, not a convenience.
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Map as LeafletMap, TileLayer as LeafletTileLayer } from 'leaflet';
import { NetworkPage, observationsToGeoJSON, rssiBand } from '../NetworkPage';

const mocks = vi.hoisted(() => ({
  getAll: vi.fn(), location: vi.fn(), radio: vi.fn(), observations: vi.fn(), saveLocation: vi.fn(), saveRadio: vi.fn(),
}));
vi.mock('../../services/api', () => ({ devicesAPI: { getAll: mocks.getAll }, networkAPI: {
  location: mocks.location, radio: mocks.radio, observations: mocks.observations,
  saveLocation: mocks.saveLocation, saveRadio: mocks.saveRadio,
} }));
vi.mock('../../components/AppHeader', () => ({ AppHeader: ({ title }: { title: string }) => <header><h1>{title}</h1></header> }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ username: 'field-admin', logout: vi.fn() }) }));
// Mirrors i18next's own precedence for a count-bearing call: the suffixed
// default wins over the bare one, so a mock that ignored `defaultValue_one`
// would let "1 positioned points" pass here and ship to the customer. Real
// plural rendering off the shipped bundles is pinned in tests/coverageLocales.test.ts.
const translate = (key: string, options?: Record<string, unknown>) => {
  const plural = options?.count === 1 ? options?.defaultValue_one : options?.defaultValue_other;
  return String(plural ?? options?.defaultValue ?? key).replace('{{count}}', String(options?.count ?? ''));
};
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));

describe('observationsToGeoJSON', () => {
  it('exports one point feature per positioned observation, carrying RSSI', () => {
    const rows = [
      { recorded_at: '2026-09-25T09:00:00Z', deveui: 'AC1F09FFFE000001', rssi: -93,
        metadata_json: JSON.stringify({ reported_position: { latitude: 46.5, longitude: 6.5 },
          receivers: [{ gateway_id: '0016C001F1000001', rssi_dbm: -93, snr_db: 7.75 }] }) },
      { recorded_at: '2026-09-25T09:01:00Z', deveui: 'AC1F09FFFE000001', rssi: null,
        metadata_json: JSON.stringify({ reported_position: null, receivers: [] }) },
    ] as any;
    const fc = observationsToGeoJSON(rows);
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry.coordinates).toEqual([6.5, 46.5]);
    expect(fc.features[0].properties.rssi_dbm).toBe(-93);
    expect(fc.features[0].properties.recorded_at).toBe('2026-09-25T09:00:00Z');
  });

  it('keeps a positioned point whose uplink carried no RSSI, as unknown rather than as a number', () => {
    const fc = observationsToGeoJSON([
      { recorded_at: '2026-09-25T09:02:00Z', deveui: 'AC1F09FFFE000001', rssi: null,
        metadata_json: JSON.stringify({ reported_position: { latitude: 46.5, longitude: 6.5 }, receivers: [] }) },
    ] as any);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties.rssi_dbm).toBeNull();
    expect(fc.features[0].properties.band).toBe('unknown');
    expect(fc.features[0].properties.gateway_count).toBe(0);
  });

  it('carries the SNR and the number of gateways that heard the uplink', () => {
    const fc = observationsToGeoJSON([
      { recorded_at: '2026-09-25T09:03:00Z', deveui: 'AC1F09FFFE000001', rssi: -71,
        metadata_json: JSON.stringify({ reported_position: { latitude: 46.5, longitude: 6.5 },
          receivers: [{ gateway_id: 'GW-1', rssi_dbm: -71, snr_db: 9.25 }, { gateway_id: 'GW-2', rssi_dbm: -104, snr_db: -3 }] }) },
    ] as any);
    expect(fc.features[0].properties.snr_db).toBe(9.25);
    expect(fc.features[0].properties.gateway_count).toBe(2);
    expect(fc.features[0].properties.gateway_ids).toEqual(['GW-1', 'GW-2']);
    expect(fc.features[0].properties.deveui).toBe('AC1F09FFFE000001');
    expect(fc.features[0].properties.band).toBe('good');
  });

  it('names the gateways that heard the point, which the map no longer draws a link for', () => {
    const fc = observationsToGeoJSON([
      { recorded_at: '2026-09-25T09:06:00Z', deveui: 'AC1F09FFFE000001', rssi: -88,
        metadata_json: JSON.stringify({ reported_position: { latitude: 46.5, longitude: 6.5 },
          receivers: [{ gateway_id: '0016C001F1000001', rssi_dbm: -88 }, { rssi_dbm: -101 }] }) },
    ] as any);
    // An unnamed receiver still counts as a gateway that heard it, but it
    // contributes no id rather than a placeholder one.
    expect(fc.features[0].properties.gateway_ids).toEqual(['0016C001F1000001']);
    expect(fc.features[0].properties.gateway_count).toBe(2);
  });

  it('survives metadata that is not JSON without losing the rest of the walk', () => {
    const fc = observationsToGeoJSON([
      { recorded_at: '2026-09-25T09:04:00Z', deveui: 'A', rssi: -80, metadata_json: 'not json' },
      { recorded_at: '2026-09-25T09:05:00Z', deveui: 'A', rssi: -80,
        metadata_json: JSON.stringify({ reported_position: { latitude: 46.5, longitude: 6.5 } }) },
    ] as any);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties.recorded_at).toBe('2026-09-25T09:05:00Z');
  });
});

describe('rssiBand', () => {
  it('spreads the tester’s useful range across five measured bands', () => {
    expect(rssiBand(-42).id).toBe('strong');
    expect(rssiBand(-60).id).toBe('strong');
    expect(rssiBand(-61).id).toBe('good');
    expect(rssiBand(-75).id).toBe('good');
    expect(rssiBand(-80).id).toBe('fair');
    expect(rssiBand(-93).id).toBe('weak');
    expect(rssiBand(-105).id).toBe('weak');
    expect(rssiBand(-119).id).toBe('marginal');
  });

  it('never invents a band for a missing or unusable reading', () => {
    expect(rssiBand(null).id).toBe('unknown');
    expect(rssiBand(undefined).id).toBe('unknown');
    expect(rssiBand(Number.NaN).id).toBe('unknown');
  });
});

const device = { deveui: 'AC1F09FFFE000001', name: 'Field tester', type_id: 'RAK10701_FIELD_TESTER' } as any;
const walkRow = (recordedAt: string, rssi: number | null, receiverPosition?: { latitude: number; longitude: number }) => ({
  id: recordedAt, deveui: device.deveui, recorded_at: recordedAt, rssi,
  metadata_json: JSON.stringify({ reported_position: { latitude: 46.5, longitude: 6.5 },
    receivers: [{ gateway_id: '0016C001F1000001', rssi_dbm: rssi, snr_db: 7.75, position: receiverPosition ?? null }] }),
});
const page = (rows: unknown[]) => ({ rows, truncated: false, nextOffset: null, from: '2026-09-25T08:00:00Z', to: '2026-09-25T09:00:00Z' });
const renderPage = () => render(<MemoryRouter><NetworkPage /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('crypto', { randomUUID: () => '11111111-1111-4111-8111-111111111111' });
  mocks.getAll.mockResolvedValue([device]); mocks.location.mockResolvedValue(null); mocks.radio.mockResolvedValue(null);
  mocks.observations.mockResolvedValue(page([]));
});

describe('the coverage view', () => {
  it('explains that capture is off instead of raising an error over an empty map', async () => {
    mocks.observations.mockRejectedValue({ response: { status: 503, data: { error: 'radio observations unavailable' } } });
    renderPage();

    expect(await screen.findByText(/Radio capture is switched off/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Updates paused')).not.toBeInTheDocument();
  });

  it('keeps the existing paused banner for an unavailability that is not the capture flag', async () => {
    mocks.observations.mockRejectedValue({ response: { status: 503, data: { error: 'network_api_unavailable' } } });
    renderPage();

    expect(await screen.findByText('Updates paused')).toBeInTheDocument();
    expect(screen.queryByText(/Radio capture is switched off/)).not.toBeInTheDocument();
  });

  it('says the gateway has no recorded position when the walk has points and the receivers do not', async () => {
    mocks.observations.mockResolvedValue(page([walkRow('2026-09-25T09:00:00Z', -93)]));
    renderPage();

    expect(await screen.findByText(/No gateway position is recorded/)).toBeInTheDocument();
    expect(await screen.findByText('1 positioned point')).toBeInTheDocument();
  });

  it('drops the no-position note once a receiver resolves to a gateway position', async () => {
    mocks.observations.mockResolvedValue(page([walkRow('2026-09-25T09:00:00Z', -93, { latitude: 46.51, longitude: 6.51 })]));
    renderPage();

    await screen.findByText('1 positioned point');
    expect(screen.queryByText(/No gateway position is recorded/)).not.toBeInTheDocument();
  });

  it('does not claim the window holds no positioned point when it could not read the window', async () => {
    // The device has an installed location, so `known` is non-empty and the
    // no-position line would otherwise render under the red alert and the amber
    // pause -- three states at once, the third of them a fact the page does not
    // have.
    mocks.location.mockResolvedValue({ revisionUuid: 'r1', revisionNo: 1, latitude: 46.5, longitude: 6.5, effectiveFrom: '2026-09-25T08:00:00Z', coordinateSource: 'manual' });
    mocks.observations.mockRejectedValue({ response: { status: 503, data: { error: 'network_api_unavailable' } } });
    renderPage();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Updates paused')).toBeInTheDocument();
    expect(screen.queryByText(/No observation in this window carries a position/)).not.toBeInTheDocument();
  });

  it('says the window holds no positioned point rather than calling a mapped gateway unknown', async () => {
    mocks.observations.mockResolvedValue(page([{ id: 'x', deveui: device.deveui, recorded_at: '2026-09-25T09:00:00Z', rssi: -93,
      metadata_json: JSON.stringify({ reported_position: null, receivers: [{ gateway_id: '0016C001F1000001', rssi_dbm: -93, position: { latitude: 46.51, longitude: 6.51 } }] }) }]));
    renderPage();

    expect(await screen.findByText(/No observation in this window carries a position/)).toBeInTheDocument();
    expect(screen.queryByText('No known positions')).not.toBeInTheDocument();
    expect(screen.getByText('0 positioned points')).toBeInTheDocument();
  });

  it('keeps the operator’s zoom when a window change brings back the same points', async () => {
    // The scenario the map has to survive on 25 September: someone has zoomed
    // into a weak-signal cluster and switches the window to check progress. The
    // fetch clears the rows and reloads them, so the coordinates leave and come
    // back — the map must not treat that as new data and snap to full bounds.
    const rows = [walkRow('2026-09-25T09:00:00Z', -93, { latitude: 46.51, longitude: 6.51 })];
    mocks.observations.mockResolvedValue(page(rows));
    const fitBounds = vi.spyOn(LeafletMap.prototype, 'fitBounds');
    try {
      renderPage();
      await screen.findByText('1 positioned point');
      await waitFor(() => expect(fitBounds).toHaveBeenCalled());
      const framed = fitBounds.mock.calls.length;

      fireEvent.change(screen.getByLabelText(/Time window/), { target: { value: '168' } });
      await waitFor(() => expect(mocks.observations).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.queryByText('Loading observations…')).not.toBeInTheDocument());
      expect(screen.getByText('1 positioned point')).toBeInTheDocument();

      expect(fitBounds).toHaveBeenCalledTimes(framed);
    } finally { fitBounds.mockRestore(); }
  });

  it('still re-frames when the new window genuinely brings different points', async () => {
    mocks.observations
      .mockResolvedValueOnce(page([walkRow('2026-09-25T09:00:00Z', -93, { latitude: 46.51, longitude: 6.51 })]))
      .mockResolvedValueOnce(page([walkRow('2026-09-25T09:00:00Z', -93, { latitude: 46.51, longitude: 6.51 }),
        { id: 'b', deveui: device.deveui, recorded_at: '2026-09-25T08:30:00Z', rssi: -70,
          metadata_json: JSON.stringify({ reported_position: { latitude: 46.52, longitude: 6.52 }, receivers: [] }) }]));
    const fitBounds = vi.spyOn(LeafletMap.prototype, 'fitBounds');
    try {
      renderPage();
      await screen.findByText('1 positioned point');
      await waitFor(() => expect(fitBounds).toHaveBeenCalled());
      const framed = fitBounds.mock.calls.length;

      fireEvent.change(screen.getByLabelText(/Time window/), { target: { value: '168' } });
      await screen.findByText('2 positioned points');

      await waitFor(() => expect(fitBounds.mock.calls.length).toBeGreaterThan(framed));
    } finally { fitBounds.mockRestore(); }
  });

  it('asks the endpoint for the chosen window', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Network observations', level: 1 });
    await waitFor(() => expect(mocks.observations).toHaveBeenCalledWith(500, 0, { hours: 24 }));

    fireEvent.change(screen.getByLabelText(/Time window/), { target: { value: '168' } });
    await waitFor(() => expect(mocks.observations).toHaveBeenLastCalledWith(500, 0, { hours: 168 }));
  });

  it('downloads the visible walk as a dated GeoJSON file', async () => {
    mocks.observations.mockResolvedValue(page([walkRow('2026-09-25T09:00:00Z', -93)]));
    const created: string[] = [];
    vi.stubGlobal('URL', Object.assign(Object.create(URL), {
      createObjectURL: (blob: Blob) => { created.push(blob.type); return 'blob:coverage'; },
      revokeObjectURL: () => {},
    }));
    const clicks: Array<{ download: string; href: string }> = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push({ download: this.download, href: this.href });
    });
    try {
      renderPage();
      await screen.findByText('1 positioned point');
      fireEvent.click(screen.getByRole('button', { name: 'GeoJSON' }));
      expect(clicks).toHaveLength(1);
      expect(clicks[0].download).toMatch(/^coverage-\d{4}-\d{2}-\d{2}\.geojson$/);
      expect(created).toEqual(['application/geo+json']);
    } finally { click.mockRestore(); vi.unstubAllGlobals(); }
  });

  it('offers no export when the window holds nothing to export', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Network observations', level: 1 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'GeoJSON' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'CSV' })).toBeDisabled();
  });

  it('prints every band’s range and count so colour is not the only channel', async () => {
    mocks.observations.mockResolvedValue(page([walkRow('2026-09-25T09:00:00Z', -50), walkRow('2026-09-25T09:01:00Z', -93)]));
    renderPage();

    await screen.findByText('2 positioned points');
    const legend = screen.getByRole('list', { name: /Signal strength/ });
    expect(legend).toHaveTextContent('≥ -60');
    expect(legend).toHaveTextContent('< -105');
    expect(legend).toHaveTextContent('Strong');
    expect(legend).toHaveTextContent('Weak');
    expect(screen.getByTestId('coverage-band-strong')).toHaveTextContent('· 1');
    expect(screen.getByTestId('coverage-band-weak')).toHaveTextContent('· 1');
    expect(screen.getByTestId('coverage-band-good')).toHaveTextContent('· 0');
    // A band with no measured points is still named, so the ramp does not
    // renumber itself between windows.
    expect(screen.queryByTestId('coverage-band-unknown')).not.toBeInTheDocument();
  });

  it('hides the installed-location and radio-configuration panels for a handheld field tester', async () => {
    // `device` above carries type_id RAK10701_FIELD_TESTER: a unit walked
    // around the farm has no mast to install and no fixed radio link budget.
    renderPage();
    await screen.findByRole('heading', { name: 'Network observations', level: 1 });
    expect(screen.queryByText('Installed location')).not.toBeInTheDocument();
    expect(screen.queryByText('Radio configuration')).not.toBeInTheDocument();
  });

  it('caps the automatic fit-to-bounds below the tile server’s native ceiling', async () => {
    // OpenTopoMap has no tile past native zoom 17 (D1); a coverage walk
    // crowds points into a few metres and an unclamped fit would zoom the map
    // straight onto the "max zoom layer = 17" placeholder tile.
    mocks.observations.mockResolvedValue(page([walkRow('2026-09-25T09:00:00Z', -93, { latitude: 46.51, longitude: 6.51 })]));
    const fitBounds = vi.spyOn(LeafletMap.prototype, 'fitBounds');
    try {
      renderPage();
      await screen.findByText('1 positioned point');
      await waitFor(() => expect(fitBounds).toHaveBeenCalled());
      expect(fitBounds.mock.calls[0][1]).toMatchObject({ maxZoom: 16 });
      // The map's own ceiling stays above both the fit cap and the tile
      // server's native maximum, so a user can still zoom in by hand.
      expect((fitBounds.mock.instances[0] as any).options.maxZoom).toBe(19);
    } finally { fitBounds.mockRestore(); }
  });

  it('caps a single-point window the same way, rather than zooming in as far as the map allows', async () => {
    // A lone reading (the first uplink of a walk, or a device with exactly
    // one positioned observation) makes Leaflet's own bounds degenerate to a
    // point; without an explicit cap that zooms to the map's ceiling, which is
    // the exact case a solo tester reading would otherwise hit hardest. No
    // receiver position this time, so the fed points are the device fix alone
    // -- one coordinate, not the device plus a gateway at the same spot.
    mocks.observations.mockResolvedValue(page([walkRow('2026-09-25T09:00:00Z', -93)]));
    const fitBounds = vi.spyOn(LeafletMap.prototype, 'fitBounds');
    try {
      renderPage();
      await screen.findByText('1 positioned point');
      await waitFor(() => expect(fitBounds).toHaveBeenCalled());
      const [bounds, options] = fitBounds.mock.calls[0];
      expect((bounds as [number, number][]).length).toBe(1);
      expect(options).toMatchObject({ maxZoom: 16 });
    } finally { fitBounds.mockRestore(); }
  });

  it('scales the last real tile above the OpenTopoMap native ceiling instead of requesting a placeholder', async () => {
    const onAdd = vi.spyOn(LeafletTileLayer.prototype, 'onAdd');
    try {
      renderPage();
      await screen.findByRole('heading', { name: 'Network observations', level: 1 });
      await waitFor(() => expect(onAdd).toHaveBeenCalled());
      const instance = onAdd.mock.instances[0] as any;
      expect(instance.options.maxNativeZoom).toBe(17);
    } finally { onAdd.mockRestore(); }
  });
});
