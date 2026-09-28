import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type React from 'react';
import { CircleMarker, MapContainer, Popup, Polyline, TileLayer, ZoomControl, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Feature, FeatureCollection, Point } from 'geojson';
import { AppHeader } from '../components/AppHeader';
import { devicesAPI, networkAPI, type InstallationLocationRevision, type RadioConfigurationRevision, type NetworkObservation } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import type { Device } from '../types/farming';
import { useDateFormat } from '../utils/datetime';
import { Button } from '../ui-core';

const fallback = (key: string, value: string) => ({ defaultValue: value, key });
type Position = { lat: number; lon: number };
type ParsedObservation = { observation: NetworkObservation; device: Position | null; receivers: Array<Position & { id: string }> };
const parsePosition = (value: any): Position | null => { if (value?.latitude == null || value?.longitude == null || value?.latitude === '' || value?.longitude === '') return null; const lat = Number(value.latitude); const lon = Number(value.longitude); return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 ? { lat, lon } : null; };
export const parseObservation = (observation: NetworkObservation): ParsedObservation => { try { const metadata = JSON.parse(observation.metadata_json ?? '{}'); const receivers = (Array.isArray(metadata.receivers) ? metadata.receivers : []).flatMap((receiver: any) => { const point = parsePosition(receiver?.position); return point ? [{ ...point, id: String(receiver?.gateway_id ?? 'unknown') }] : []; }); return { observation, device: parsePosition(metadata.reported_position) ?? parsePosition(metadata.device_location), receivers }; } catch { return { observation, device: null, receivers: [] }; } };
/**
 * Frames the map once per distinct set of coordinates, and never again for the
 * same one -- except that a 15 s refresh tick (see the polling effect below)
 * must never re-fit just because it merged in a point the operator can already
 * see, or every tick would throw away a manual zoom/pan mid-walk.
 *
 * The page rebuilds `points` as a fresh array on every render, so depending on
 * the array itself re-fitted the map whenever the operator touched the window
 * control — discarding the zoom they had just made into a weak-signal cluster,
 * mid-walk, in front of the customer.
 *
 * A coordinate fingerprint alone does not fix it, because the observations
 * effect clears the rows before refetching: the fingerprint round-trips
 * `A -> '' -> A`, and that last step is a change. So the fingerprint actually
 * framed is remembered, and an empty set neither fits nor forgets it.
 *
 * A 15 s refresh tick (see the polling effect below) merges new rows into
 * `observations` in place, without ever clearing it -- so a tick's new points
 * reach this component as a *different* fingerprint with no intervening empty
 * frame. Framing on every different fingerprint would re-fit on every tick,
 * throwing away a manual zoom/pan into a weak-signal cluster mid-walk. So once
 * a first framing has happened, a new fingerprint only re-fits when its bounds
 * actually reach outside what the map already shows; one that stays inside
 * the current view updates `framed` (so it is not re-checked) without moving
 * the map.
 *
 * No separate re-fit on device or window change: `observations` IS cleared
 * before that refetch, so `points` passes through empty (the `!fingerprint`
 * guard) on the way, and a device also contributes its own installed-location
 * marker to `points` -- between the two, a switch almost always brings points
 * the current view does not contain, so the same outside-the-view check
 * re-fits it too, without needing to know why the fingerprint changed.
 */
// OpenTopoMap's own tiles stop at native zoom 17 (below, the layer scales the
// z17 tile up rather than fetching one that does not exist). A coverage walk
// crowds many points into a few metres, so an unclamped fit-to-bounds reads
// that as "zoom in until the points separate" and drives straight past 17 --
// onto the "max zoom layer = 17" placeholder tile, full-frame, in front of the
// customer. The cap sits one level below the tile ceiling so the auto-fit
// always lands on real imagery; a user can still zoom in further by hand
// (MAP_MAX_ZOOM below), trading real tiles for the same upscaled ones the cap
// avoids handing them automatically.
const FIT_BOUNDS_MAX_ZOOM = 16;
// The map's own ceiling, kept above FIT_BOUNDS_MAX_ZOOM and above the tile
// server's native maximum (TILE_MAX_NATIVE_ZOOM) on purpose: zoom control
// still works past 17, Leaflet just scales the z17 tile rather than requesting
// a z18/z19 tile that would 404.
const MAP_MAX_ZOOM = 19;
// Passed to TileLayer as `maxNativeZoom`: OpenTopoMap serves no tile beyond
// this zoom. Leaflet upscales the last real tile above it instead of drawing
// the placeholder.
const TILE_MAX_NATIVE_ZOOM = 17;
function FitBounds({ points }: { points: Position[] }) {
  const map = useMap();
  const fingerprint = points.map(point => `${point.lat},${point.lon}`).join('|');
  const framed = useRef<string | null>(null);
  useEffect(() => {
    if (!fingerprint || fingerprint === framed.current) return;
    if (framed.current !== null) {
      // Not the very first framing (that branch below always fits
      // unconditionally): only re-fit if the new points reach outside what is
      // already on screen. This is what makes a 15 s refresh tick that merges
      // in a point inside the current view leave the operator's zoom/pan
      // alone, while a device/window switch still normally re-fits too, since
      // it typically brings points the current (different) view does not
      // contain.
      const bounds = L.latLngBounds(points.map(point => [point.lat, point.lon] as [number, number]));
      if (map.getBounds().contains(bounds)) { framed.current = fingerprint; return; }
    }
    framed.current = fingerprint;
    // `maxZoom` also governs the degenerate single-point case: fitBounds on a
    // zero-size box would otherwise zoom in as far as the map allows, which is
    // exactly the case a lone tester reading loses to a wall of placeholders.
    map.fitBounds(points.map(point => [point.lat, point.lon] as [number, number]), { padding: [24, 24], maxZoom: FIT_BOUNDS_MAX_ZOOM });
  }, [map, fingerprint, points]);
  return null;
}
const observationReceivers = (observation: NetworkObservation): any[] => { try { const receivers = JSON.parse(observation.metadata_json ?? '{}')?.receivers; return Array.isArray(receivers) ? receivers : []; } catch { return []; } };
const observationRssi = (observation: NetworkObservation): number | null => {
  if (observation.rssi != null) return observation.rssi;
  const heard = observationReceivers(observation).find((receiver: any) => receiver?.rssi_dbm != null)?.rssi_dbm;
  return heard == null ? null : Number(heard);
};

// Coverage walk (RAK10701 field test, 2026-09-25). A tester reads about
// -40 dBm standing beside the gateway and loses the link around -120 dBm, so
// five 15 dB steps anchored at -60 spread that whole range instead of putting
// every real reading in one colour. Fills are ColorBrewer RdYlBu-5, which is
// colour-blind safe; the radius repeats the same order so the ramp still reads
// without colour, and the legend prints each band's dBm range and its count as
// text so colour is never the only channel.
export type RssiBandId = 'strong' | 'good' | 'fair' | 'weak' | 'marginal' | 'unknown';
export type RssiBand = { id: RssiBandId; floor: number | null; range: string; color: string; radius: number };
export const RSSI_BANDS: RssiBand[] = [
  { id: 'strong', floor: -60, range: '≥ -60', color: '#2C7BB6', radius: 8 },
  { id: 'good', floor: -75, range: '-75 … -60', color: '#ABD9E9', radius: 7 },
  { id: 'fair', floor: -90, range: '-90 … -75', color: '#FFFFBF', radius: 6 },
  { id: 'weak', floor: -105, range: '-105 … -90', color: '#FDAE61', radius: 5 },
  { id: 'marginal', floor: null, range: '< -105', color: '#D7191C', radius: 4 },
];
// A point whose uplink carried no RSSI is still evidence that the walk passed
// there, so it is drawn rather than dropped — in its own grey, never folded
// into a measured band.
export const RSSI_BAND_UNKNOWN: RssiBand = { id: 'unknown', floor: null, range: '', color: '#94A3B8', radius: 4 };
export const rssiBand = (rssi: number | null | undefined): RssiBand => { if (rssi == null || !Number.isFinite(Number(rssi))) return RSSI_BAND_UNKNOWN; const value = Number(rssi); return RSSI_BANDS.find(band => band.floor === null || value >= band.floor) ?? RSSI_BAND_UNKNOWN; };

/**
 * Properties osi-planner reads back off a coverage export; `rssi_dbm` and
 * `recorded_at` are its contract. `gateway_ids` names which gateways heard the
 * point — the map no longer draws a link per receiver, so the export is the only
 * place that fact survives, and on a two-gateway farm it is the whole question.
 * It lists the ids that are known, so it can be shorter than `gateway_count`,
 * which counts receivers whether or not they named themselves.
 */
export type CoverageProperties = { rssi_dbm: number | null; recorded_at: string; deveui: string; snr_db: number | null; gateway_count: number; gateway_ids: string[]; band: RssiBandId };
/** The visible walk as GeoJSON — one Point per positioned observation, coordinates [longitude, latitude]. */
export const observationsToGeoJSON = (rows: NetworkObservation[]): FeatureCollection<Point, CoverageProperties> => ({
  type: 'FeatureCollection',
  features: rows.flatMap((row): Array<Feature<Point, CoverageProperties>> => {
    const point = parseObservation(row).device;
    if (!point) return [];
    const rssi = observationRssi(row);
    const receivers = observationReceivers(row);
    const snr = receivers.map((receiver: any) => receiver?.snr_db).find((value: any) => value != null && Number.isFinite(Number(value)));
    // `Number(null)` is 0, so the null check has to come first: a point with no
    // reading must not leave here as a plausible 0 dBm.
    return [{ type: 'Feature', geometry: { type: 'Point', coordinates: [point.lon, point.lat] }, properties: { rssi_dbm: rssi == null || !Number.isFinite(Number(rssi)) ? null : Number(rssi), recorded_at: row.recorded_at, deveui: row.deveui, snr_db: snr == null ? null : Number(snr), gateway_count: receivers.length, gateway_ids: receivers.flatMap((receiver: any) => receiver?.gateway_id == null ? [] : [String(receiver.gateway_id)]), band: rssiBand(rssi).id } }];
  }),
});
const downloadFile = (name: string, type: string, body: string) => {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([body], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.style.display = 'none';
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
};
// Hours, matching the observations endpoint's own `hours` parameter, whose
// ceiling is 30 days.
const COVERAGE_WINDOWS = [1, 6, 24, 168, 720];
// The observations route is one of three consumers of OSI_RADIO_CAPTURE_ENABLED
// and answers 503 with this body when capture is off. That is a configuration
// state, not a fault, so it gets an explanation rather than an error banner.
const CAPTURE_OFF_ERROR = 'radio observations unavailable';
// The observations list renders every fetched row by default, which is ~500
// rows (~20,000px) on a coverage walk -- a page nobody scrolls past. Only the
// most recent rows are shown until the operator asks for the rest; the window
// selector and "Load more" already fetch more than this, so this is a display
// cap on already-fetched data, not a second network request.
const RECENT_OBSERVATIONS_LIMIT = 20;
// A handheld field tester has no fixed install: the "Installed location" and
// "Radio configuration" panels describe a mast, not a unit someone is
// carrying, so they are hidden rather than shown empty.
const FIELD_TESTER_TYPE_ID = 'RAK10701_FIELD_TESTER';
// Coverage walk (2026-09-25): the map must fill in as the operator walks, but
// the gateway answering these requests is a Raspberry Pi 4. Each tick asks for
// only the newest handful of rows, not the 500-row page the initial load and
// "Load more" use.
const REFRESH_INTERVAL_MS = 15000;
const REFRESH_PAGE_SIZE = 50;
const observationKey = (row: NetworkObservation) => String(row.id ?? row.recorded_at);

export function NetworkPage() {
  const { t } = useTranslation('network');
  const { username, logout } = useAuth();
  const fmt = useDateFormat();
  const [windowBounds, setWindowBounds] = useState<{ from: string; to: string } | undefined>();
  const [devices, setDevices] = useState<Device[]>([]); const [devicesLoading, setDevicesLoading] = useState(true); const [selected, setSelected] = useState('');
  const [location, setLocation] = useState<InstallationLocationRevision | null>(null); const [radio, setRadio] = useState<RadioConfigurationRevision | null>(null);
  const [observations, setObservations] = useState<NetworkObservation[]>([]); const [observationsLoading, setObservationsLoading] = useState(true); const [nextOffset, setNextOffset] = useState<number | null>(null); const [error, setError] = useState<string | null>(null); const [paused, setPaused] = useState(false); const [loadingMore, setLoadingMore] = useState(false);
  const [hours, setHours] = useState(24); const [captureOff, setCaptureOff] = useState(false);
  const [showAllObservations, setShowAllObservations] = useState(false);
  // Nothing selectable means the observation effect below never runs, so this
  // is the only place that can retire the observations spinner in that case.
  useEffect(() => { devicesAPI.getAll().then(value => { setDevices(value); if (value[0]) setSelected(value[0].deveui); else setObservationsLoading(false); }).catch(() => { setError(t('network.loadError', fallback('loadError', 'Could not load devices'))); setObservationsLoading(false); }).finally(() => setDevicesLoading(false)); }, [t]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    setError(null); setLocation(null); setRadio(null); setObservationsLoading(true); setCaptureOff(false);
    // Rows from the previous window must not survive into this one: the window
    // selector makes that reachable, and a page of points drawn under a window
    // they were not measured in is a false reading of the walk.
    setObservations([]); setNextOffset(null); setShowAllObservations(false);
    networkAPI.location(selected).then(value => { if (active) setLocation(value); }).catch(() => { if (active) setLocation(null); });
    networkAPI.radio(selected).then(value => { if (active) setRadio(value); }).catch(() => { if (active) setRadio(null); });
    networkAPI.observations(500, 0, { hours }).then(page => {
      if (!active) return;
      setObservations(page.rows); setWindowBounds({ from: page.from, to: page.to }); setNextOffset(page.nextOffset); setPaused(false);
    }).catch((e: any) => {
      if (!active) return;
      const off = e?.response?.status === 503 && String(e?.response?.data?.error ?? '') === CAPTURE_OFF_ERROR;
      setCaptureOff(off); setPaused(e?.response?.status === 503 && !off);
      if (!off) setError(t('network.unavailable', fallback('unavailable', 'Network data temporarily unavailable')));
    }).finally(() => { if (active) setObservationsLoading(false); });
    return () => { active = false; };
  }, [hours, selected, t]);
  // Coverage walk (2026-09-25): new uplinks must appear on the map while the
  // operator is still walking, without the customer pressing F5. Every
  // REFRESH_INTERVAL_MS this asks for only the newest REFRESH_PAGE_SIZE rows
  // (the endpoint's own `hours` window against the real current time, not the
  // fixed `windowBounds` the initial page and "Load more" paginate against --
  // that window's `to` is frozen at first load and would never surface
  // anything recorded after it) and merges by id into what is already drawn.
  // Paused while the tab is hidden, so a laptop left open overnight is not
  // quietly hammering a Pi 4 gateway. A failed tick keeps the last drawn data
  // and is left for the next tick to retry -- it must never blank the map or
  // raise the page-level error over what is, for a walk, a routine miss.
  useEffect(() => {
    if (!selected || captureOff) return;
    let active = true;
    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      networkAPI.observations(REFRESH_PAGE_SIZE, 0, { hours }).then(page => {
        if (!active) return;
        setObservations(rows => {
          const seen = new Set(rows.map(observationKey));
          const fresh = page.rows.filter(row => !seen.has(observationKey(row)));
          return fresh.length ? [...fresh, ...rows] : rows;
        });
        setPaused(false);
      }).catch(() => { /* keep what is drawn; the next tick retries */ });
    };
    const id = window.setInterval(tick, REFRESH_INTERVAL_MS);
    return () => { active = false; window.clearInterval(id); };
  }, [hours, selected, captureOff]);
  const loadMore = async () => { if (nextOffset === null || loadingMore) return; setLoadingMore(true); try { const page = await networkAPI.observations(Math.min(500, 5000 - observations.length), nextOffset, windowBounds); setObservations(rows => [...rows, ...page.rows]); setNextOffset(observations.length + page.rows.length >= 5000 ? null : page.nextOffset); } catch (e: any) { setError(t('network.unavailable', fallback('unavailable', 'Network data temporarily unavailable'))); } finally { setLoadingMore(false); } };
  const saveLocation = async (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); if (!selected) return; const data = new FormData(event.currentTarget); try { const value = await networkAPI.saveLocation(selected, { revision_uuid: crypto.randomUUID(), base_revision_uuid: location?.revisionUuid ?? null, values: { latitude: Number(data.get('latitude')), longitude: Number(data.get('longitude')), effectiveFrom: new Date().toISOString(), coordinateSource: 'manual' } }); setLocation(value); setError(null); } catch (e: any) { setError(e?.response?.status === 409 ? t('network.conflict', fallback('conflict', 'This record changed. Reload before saving.')) : t('network.saveError', fallback('saveError', 'Could not save'))); } };
  const saveRadio = async (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); if (!selected) return; const data = new FormData(event.currentTarget); try { const value = await networkAPI.saveRadio(selected, { revision_uuid: crypto.randomUUID(), base_revision_uuid: radio?.revisionUuid ?? null, values: { txPowerDbm: data.get('txPowerDbm') === '' ? null : Number(data.get('txPowerDbm')), antennaGainDbi: data.get('antennaGainDbi') === '' ? null : Number(data.get('antennaGainDbi')), feederLossDb: data.get('feederLossDb') === '' ? null : Number(data.get('feederLossDb')), effectiveFrom: new Date().toISOString(), configurationSource: 'manual' } }); setRadio(value); setError(null); } catch (e: any) { setError(e?.response?.status === 409 ? t('network.conflict', fallback('conflict', 'This record changed. Reload before saving.')) : t('network.saveError', fallback('saveError', 'Could not save'))); } };
  const parsed = observations.map(parseObservation); const snapshots = parsed.flatMap(item => item.device ? [{ ...item.device, label: item.observation.deveui }] : []); const known = [...(location ? [{ lat: location.latitude, lon: location.longitude, label: selected }] : []), ...snapshots];
  // The walk in the order it was walked; the endpoint answers newest first.
  const track = [...parsed].sort((a, b) => Date.parse(a.observation.recorded_at) - Date.parse(b.observation.recorded_at)).flatMap(item => { if (!item.device) return []; const rssi = observationRssi(item.observation); return [{ ...item.device, observation: item.observation, rssi, band: rssiBand(rssi) }]; });
  // One path per device: the endpoint answers for every visible device, so a
  // single polyline would zigzag between two devices' positions and draw a walk
  // nobody took.
  const trackPaths = new Map<string, Array<[number, number]>>(); for (const point of track) { const path = trackPaths.get(point.observation.deveui) ?? []; path.push([point.lat, point.lon]); trackPaths.set(point.observation.deveui, path); }
  // One marker per gateway, not one per uplink it heard: a walk of two hundred
  // points would otherwise stack two hundred markers on the same mast.
  const gateways: Array<Position & { id: string }> = []; for (const item of parsed) for (const receiver of item.receivers) if (!gateways.some(seen => seen.id === receiver.id)) gateways.push(receiver);
  const bandCounts = track.reduce((counts, point) => counts.set(point.band.id, (counts.get(point.band.id) ?? 0) + 1), new Map<RssiBandId, number>());
  const legendBands = [...RSSI_BANDS, ...((bandCounts.get('unknown') ?? 0) > 0 ? [RSSI_BAND_UNKNOWN] : [])];
  // Plural-aware: the first uplink of a walk makes this 1, and "1 points
  // positionnés" on the customer's screen is the moment the view stops reading
  // as a product. The window labels below need no such forms — COVERAGE_WINDOWS
  // never yields a count of 1, since the one-hour option has its own key.
  const pointCount = (count: number) => t('network.coverage.points', { count, defaultValue: '{{count}} positioned points', defaultValue_one: '{{count}} positioned point', defaultValue_other: '{{count}} positioned points' });
  const bandCountLabel = (band: RssiBand) => pointCount(bandCounts.get(band.id) ?? 0);
  const windowLabel = (value: number) => value === 1
    ? t('network.coverage.windowLastHour', fallback('coverage.windowLastHour', 'Last hour'))
    : value < 48 ? t('network.coverage.windowHours', { count: value, defaultValue: 'Last {{count}} hours' }) : t('network.coverage.windowDays', { count: Math.round(value / 24), defaultValue: 'Last {{count}} days' });
  // Built on demand rather than per render: re-parsing every row's metadata a
  // second time costs a walk-sized page nothing at click time and a lot at 20 fps.
  const exportCoverage = (format: 'geojson' | 'csv') => {
    const collection = observationsToGeoJSON(observations); const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'geojson') return downloadFile(`coverage-${stamp}.geojson`, 'application/geo+json', JSON.stringify(collection));
    const rows = collection.features.map(feature => [feature.properties.recorded_at, feature.properties.deveui, feature.geometry.coordinates[1], feature.geometry.coordinates[0], feature.properties.rssi_dbm ?? '', feature.properties.snr_db ?? '', feature.properties.gateway_count, feature.properties.band].join(','));
    return downloadFile(`coverage-${stamp}.csv`, 'text/csv', ['recorded_at,deveui,latitude,longitude,rssi_dbm,snr_db,gateway_count,band', ...rows].join('\n'));
  };
  // A handheld tester has no mast to install or radio link budget to record,
  // so the two forms below are not rendered for it at all (D4) rather than
  // shown empty.
  const selectedDevice = devices.find(d => d.deveui === selected);
  const isFieldTester = selectedDevice?.type_id === FIELD_TESTER_TYPE_ID;
  // A raw EUI in a popup or an observation row reads as a debug log; the name
  // is what the operator called the device when they added it.
  const nameOf = (eui: string) => devices.find(d => d.deveui === eui)?.name ?? eui;
  const unknownDevices = devices.filter(d => !known.some(point => point.label === d.deveui));
  // Newest first already (the endpoint's own order), so the first
  // RECENT_OBSERVATIONS_LIMIT rows are the most recent ones without a sort.
  const visibleObservations = showAllObservations ? observations : observations.slice(0, RECENT_OBSERVATIONS_LIMIT);
  const CARD = 'rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4 shadow-sm';
  const FIELD = 'rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-[var(--text)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--focus)]';
  return <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
    <AppHeader title={t('network.title', fallback('title', 'Network observations'))} activeTab="network" username={username} onLogout={logout} />
    <main className="mx-auto max-w-7xl px-4 py-8">
    {error && <p role="alert" className="my-4 rounded-lg bg-[var(--error-bg)] p-3 text-sm text-[var(--error-text)]">{error}</p>}{paused && <p className="my-4 rounded-lg bg-[var(--warn-bg)] p-3 text-sm text-[var(--warn-text)]">{t('network.paused', fallback('paused', 'Updates paused'))}</p>}
    <label className="mt-5 block">{t('network.device', fallback('device', 'Device'))} <select value={selected} onChange={e => setSelected(e.target.value)} disabled={devicesLoading} className={`ml-2 ${FIELD}`}>{devices.map(d => <option key={d.deveui} value={d.deveui}>{d.name} ({d.deveui})</option>)}</select></label>
    {devicesLoading && <p className="mt-2 text-sm text-[var(--text-secondary)]">{t('network.loadingDevices', fallback('loadingDevices', 'Loading devices…'))}</p>}
    {!devicesLoading && devices.length === 0 && <p className="mt-2 text-sm text-[var(--text-secondary)]">{t('network.noDevices', fallback('noDevices', 'No devices are known to this gateway yet'))}</p>}
    {!isFieldTester && <section key={`${selected}-${location?.revisionUuid ?? 'new'}-${radio?.revisionUuid ?? 'new'}`} className="mt-6 grid gap-5 md:grid-cols-2"><form key={`${selected}-${location?.revisionUuid ?? 'new'}`} onSubmit={saveLocation} className={CARD}><h2 className="font-semibold text-[var(--text)]">{t('network.location', fallback('location', 'Installed location'))}</h2><input name="latitude" type="number" min="-90" max="90" step="any" defaultValue={location?.latitude ?? ''} placeholder={t('network.latitude', fallback('latitude', 'Latitude'))} className={`mr-2 mt-3 ${FIELD}`} required /><input name="longitude" type="number" min="-180" max="180" step="any" defaultValue={location?.longitude ?? ''} placeholder={t('network.longitude', fallback('longitude', 'Longitude'))} className={`mt-3 ${FIELD}`} required /><Button type="submit" className="mt-3 block px-3 py-2">{t('network.save', fallback('save', 'Save'))}</Button><p className="mt-2 text-sm text-[var(--text-secondary)]">{location ? `${location.coordinateSource} · ${location.effectiveFrom}` : t('network.unknown', fallback('unknown', 'Unknown'))}</p></form>
    <form key={`${selected}-${radio?.revisionUuid ?? 'new'}`} onSubmit={saveRadio} className={CARD}><h2 className="font-semibold text-[var(--text)]">{t('network.radio', fallback('radio', 'Radio configuration'))}</h2><input name="txPowerDbm" type="number" step="any" defaultValue={radio?.txPowerDbm ?? ''} placeholder={t('network.txPower', fallback('txPower', 'TX power (dBm)'))} className={`mr-2 mt-3 ${FIELD}`} /><input name="antennaGainDbi" type="number" min="0" max="13" step="any" defaultValue={radio?.antennaGainDbi ?? ''} placeholder={t('network.gain', fallback('gain', 'Antenna gain (dBi)'))} className={`mr-2 mt-3 ${FIELD}`} /><input name="feederLossDb" type="number" min="0" step="any" defaultValue={radio?.feederLossDb ?? ''} placeholder={t('network.loss', fallback('loss', 'Feeder loss (dB)'))} className={`mt-3 ${FIELD}`} /><Button type="submit" className="mt-3 block px-3 py-2">{t('network.save', fallback('save', 'Save'))}</Button></form></section>}
    <section className={`mt-6 ${CARD}`}><h2 className="font-semibold text-[var(--text)]">{t('network.map', fallback('map', 'Network map'))}</h2>
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm"><span className="flex items-center gap-2"><label htmlFor="coverage-window">{t('network.coverage.window', fallback('coverage.window', 'Time window'))}</label><select id="coverage-window" value={hours} onChange={event => setHours(Number(event.target.value))} className={FIELD}>{COVERAGE_WINDOWS.map(option => <option key={option} value={option}>{windowLabel(option)}</option>)}</select></span>
      <span className="flex items-center gap-2"><span id="coverage-export">{t('network.coverage.export', fallback('coverage.export', 'Export'))}</span><span role="group" aria-labelledby="coverage-export" className="flex gap-2"><Button variant="secondary" onClick={() => exportCoverage('geojson')} disabled={!track.length} className="px-3 py-2 disabled:opacity-50">GeoJSON</Button><Button variant="secondary" onClick={() => exportCoverage('csv')} disabled={!track.length} className="px-3 py-2 disabled:opacity-50">CSV</Button></span></span>
      <span className="text-[var(--text-secondary)] sm:ml-auto">{pointCount(track.length)}</span></div>
    <MapContainer className="mt-3 h-96 rounded-lg" center={[46.8, 8.2]} zoom={8} minZoom={2} maxZoom={MAP_MAX_ZOOM} maxBounds={[[-85, -180], [85, 180]]} worldCopyJump={false} zoomControl={false} aria-label={t('network.map', fallback('map', 'Network map'))}>{/* Leaflet's built-in zoom control hardcodes the English "Zoom in"/"Zoom out" titles, so it is replaced with a titled one (F59). */}<ZoomControl position="topleft" zoomInTitle={t('network.zoomIn', fallback('zoomIn', 'Zoom in'))} zoomOutTitle={t('network.zoomOut', fallback('zoomOut', 'Zoom out'))} /><TileLayer attribution="© OpenTopoMap contributors" url="https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png" maxNativeZoom={TILE_MAX_NATIVE_ZOOM} /><FitBounds points={[...known, ...gateways]} />
      {/* The walk in order, then its points over it, then the gateway on top —
          Leaflet paints in DOM order and the mast must never be hidden. */}
      {[...trackPaths].flatMap(([deveui, path]) => path.length > 1 ? [<Polyline key={`track-${deveui}`} positions={path} pathOptions={{ color: '#334155', weight: 2, opacity: 0.55 }} />] : [])}
      {track.map((point, index) => <CircleMarker key={`point-${point.observation.recorded_at}-${index}`} center={[point.lat, point.lon]} radius={point.band.radius} pathOptions={{ color: '#0F172A', weight: 1, fillColor: point.band.color, fillOpacity: 0.9 }}><Popup>{nameOf(point.observation.deveui)} · {point.rssi == null ? t('network.unknown', fallback('unknown', 'Unknown')) : `${point.rssi} dBm`} · {fmt.dateTime(point.observation.recorded_at) ?? point.observation.recorded_at}</Popup></CircleMarker>)}
      {location && <CircleMarker key="installed" center={[location.latitude, location.longitude]} radius={8} pathOptions={{ color: '#dc2626' }}><Popup>{selected}</Popup></CircleMarker>}
      {gateways.map(gateway => <CircleMarker key={`gateway-${gateway.id}`} center={[gateway.lat, gateway.lon]} radius={9} pathOptions={{ color: '#FFFFFF', weight: 2, fillColor: '#111827', fillOpacity: 1 }}><Popup>{t('network.coverage.gateway', fallback('coverage.gateway', 'Gateway'))} · {gateway.id}</Popup></CircleMarker>)}</MapContainer>
    <h3 id="coverage-legend" className="mt-3 font-semibold text-[var(--text)]">{t('network.coverage.title', fallback('coverage.title', 'Signal strength (dBm)'))}</h3>
    {/* Legend swatch colours are the RdYlBu RSSI ramp (RSSI_BANDS/RSSI_BAND_UNKNOWN above) and encode data -- left exactly as they are, not restyled to a var(). */}
    <ul aria-labelledby="coverage-legend" className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--text)]">{legendBands.map(band => <li key={band.id} data-testid={`coverage-band-${band.id}`} title={bandCountLabel(band)} className="flex items-center gap-2"><span aria-hidden="true" className="inline-block shrink-0 rounded-full border border-current" style={{ width: band.radius * 2, height: band.radius * 2, backgroundColor: band.color }} /><span>{band.id === 'unknown' ? t('network.unknown', fallback('unknown', 'Unknown')) : band.range}</span>{band.id === 'strong' && <span>{t('network.coverage.legendStrong', fallback('coverage.legendStrong', 'Strong'))}</span>}{band.id === 'marginal' && <span>{t('network.coverage.legendWeak', fallback('coverage.legendWeak', 'Weak'))}</span>}<span className="tabular-nums">· {bandCounts.get(band.id) ?? 0}</span></li>)}</ul>
    {captureOff && <p className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 text-sm text-[var(--text-secondary)]">{t('network.coverage.captureOff', fallback('coverage.captureOff', 'Radio capture is switched off on this gateway, so no coverage points are being recorded.'))}</p>}
    {!captureOff && !devicesLoading && !observationsLoading && track.length > 0 && gateways.length === 0 && <p className="mt-2 text-sm text-[var(--text-secondary)]">{t('network.coverage.noPosition', fallback('coverage.noPosition', 'No gateway position is recorded, so the walk is drawn without a reference marker.'))}</p>}
    {/* `!error` matters: a failed fetch read no window at all, so claiming its
        observations carry no position would state a fact the page does not have,
        stacked under the red alert and the amber pause. The capture-off path
        sets no error and is excluded by `!captureOff` instead. */}
    {!captureOff && !error && !devicesLoading && !observationsLoading && track.length === 0 && (known.length > 0 || gateways.length > 0) && <p className="mt-2 text-sm text-[var(--text-secondary)]">{t('network.coverage.noPoints', fallback('coverage.noPoints', 'No observation in this window carries a position.'))}</p>}
    {/* A drawn gateway marker counts as a known position, or this line calls the map empty while the mast is on it. */}
    {!devicesLoading && !observationsLoading && known.length === 0 && gateways.length === 0 && <p className="mt-2 text-sm text-[var(--text-secondary)]">{t('network.noKnownLocations', fallback('noKnownLocations', 'No known positions'))}</p>}<p className="mt-2 text-sm text-[var(--text-secondary)]">{t('network.mapEvidence', fallback('mapEvidence', 'Only recorded positions are shown; coverage is not inferred.'))}</p></section>
    <section className={`mt-6 ${CARD}`}><h2 className="font-semibold text-[var(--text)]">{t('network.observations', fallback('observations', 'Observations'))}</h2>{!observationsLoading && <p className="mt-2 text-sm text-[var(--text-secondary)]">{t('network.observationCount', { count: observations.length, defaultValue: '{{count}} observations' })}</p>}{observationsLoading && observations.length === 0 && <p className="mt-2 text-sm text-[var(--text-secondary)]">{t('network.loadingObservations', fallback('loadingObservations', 'Loading observations…'))}</p>}{!observationsLoading && observations.length === 0 && <p className="mt-2 text-sm text-[var(--text-secondary)]">{t('network.noObservations', fallback('noObservations', 'No observations'))}</p>}{visibleObservations.map(o => { const rssi = observationRssi(o); return (
      <div key={observationKey(o)} className="flex items-center justify-between gap-3 border-t border-[var(--border)] py-2 text-sm text-[var(--text)]">
        <span className="flex items-center gap-2 truncate">
          <span aria-hidden="true" className="inline-block h-2.5 w-2.5 shrink-0 rounded-full border border-current align-middle" style={{ backgroundColor: rssiBand(rssi).color }} />
          <span className="truncate">{nameOf(o.deveui)}</span>
          <span className="text-[var(--text-secondary)]">·</span>
          <span>{fmt.dateTime(o.recorded_at) ?? o.recorded_at}</span>
        </span>
        <span className="shrink-0 tabular-nums">{rssi == null ? t('network.unknown', fallback('unknown', 'Unknown')) : `${rssi} dBm`}</span>
      </div>
    ); })}
    <div className="mt-3 flex flex-wrap gap-2">
    {observations.length > RECENT_OBSERVATIONS_LIMIT && <Button variant="secondary" onClick={() => setShowAllObservations(value => !value)} className="px-3 py-2 text-sm">{showAllObservations ? t('network.showFewerObservations', fallback('showFewerObservations', 'Show fewer')) : t('network.showAllObservations', fallback('showAllObservations', 'Show all'))}</Button>}
    {/* "Load more" fetches an older page from the server; it stays hidden
        until every row already fetched is on screen (showAllObservations, or
        the fetched set already fits under the display cap), so it never sits
        next to "Show all" implying the same thing. */}
    {nextOffset !== null && (showAllObservations || observations.length <= RECENT_OBSERVATIONS_LIMIT) && <Button variant="secondary" onClick={loadMore} disabled={loadingMore} className="px-3 py-2 text-sm">{loadingMore ? t('network.loadingMore', fallback('loadingMore', 'Loading…')) : t('network.loadMore', fallback('loadMore', 'Load more'))}</Button>}
    </div>
    {unknownDevices.length > 0 && <><h3 className="mt-4 font-semibold text-[var(--text)]">{t('network.unknownDevices', fallback('unknownDevices', 'Unknown positions'))}</h3>{unknownDevices.map(d => <div key={d.deveui} className="text-sm text-[var(--text-secondary)]">{d.name} · {t('network.unknown', fallback('unknown', 'Unknown'))}</div>)}</>}</section>
    </main>
  </div>;
}
