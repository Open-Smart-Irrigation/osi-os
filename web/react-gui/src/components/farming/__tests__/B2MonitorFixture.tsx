// Local browser fixture. API methods return synthetic data; no gateway is contacted.
import { createRoot } from 'react-dom/client';
import { createInstance, type Resource } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { WindMonitor } from '../WindMonitor';
import { RainMonitor } from '../RainMonitor';
import { DendrometerMonitor } from '../DendrometerMonitor';
import { KiwiSensorCard } from '../KiwiSensorCard';
import { EChart } from '../../analysis/EChart';
import { sensorAPI, dendroAPI } from '../../../services/api';
import type { Device } from '../../../types/farming';
import '../../../index.css';

const query = new URLSearchParams(location.search);
const surface = query.get('surface') ?? 'wind';
const state = query.get('state') ?? 'multi';
const language = query.get('lng') ?? 'en';
const theme = query.get('theme') ?? 'light';
document.documentElement.dataset.theme = theme;
const resources: Resource = {};
for (const [path, module] of Object.entries(import.meta.glob<Record<string, unknown>>('../../../../public/locales/*/{devices,common}.json', { eager: true, import: 'default' }))) {
  const [, locale, namespace] = path.match(/locales\/([^/]+)\/([^/]+)\.json$/)!;
  (resources[locale] ??= {})[namespace] = module;
}
const i18n = createInstance();
void i18n.use(initReactI18next).init({ lng: language, fallbackLng: 'en', resources, defaultNS: 'devices', interpolation: { escapeValue: false } }).then(() => {
  const rows = Array.from({ length: state === 'empty' ? 0 : 48 }, (_, index) => ({ t: new Date(Date.UTC(2026, 6, 1, 0, index * 30)).toISOString(), value: index }));
  sensorAPI.getHistory = async (_deveui, field) => {
    if (state === 'error') throw new Error('Synthetic fixture failure');
    return rows.map((row, index) => ({ ...row, value: field === 'wind_direction_deg' ? state === 'one' ? 182 : (index * 22.5) % 360 : field === 'wind_speed_mps' ? state === 'calm' ? 0 : 2 + index % 5 : field === 'wind_gust_mps' ? state === 'calm' ? 0 : 4 + index % 5 : field === 'rain_mm_delta' ? (index % 3) * 0.2 : 15 + index / 10 }));
  };
  sensorAPI.getDailyRainHistory = async (_deveui, days) => ({ timezone: 'Europe/Zurich', timezoneBasis: 'zone', periodStart: '2026-07-01T00:00:00Z', periodEnd: '2026-07-08T00:00:00Z', days: Array.from({ length: days }, (_, index) => ({ day: new Date(Date.UTC(2026, 6, 1 + index)).toISOString().slice(0, 10), period_start: null, period_end: null, total_mm: index % 3 === 0 ? null : (index % 3) * 0.4, samples: index % 3 === 0 ? 0 : 4, quality: 'received_only', so_far: index === days - 1 })) });
  dendroAPI.getHistory = async () => {
    if (state === 'error') throw new Error('Synthetic fixture failure');
    return rows.map((row, index) => ({ ...row, delta_mm: null, adc_v: null, valid: state === 'raw' ? 0 : 1, stem_change_um: state === 'baseline' || state === 'raw' ? null : index * 2 - 30, position_mm: state === 'raw' ? null : 1 + index / 100, position_raw_mm: state === 'raw' ? null : 1 + index / 100, dendro_mode_used: 'ratio_mod3', adc_ch0v: 1.1, adc_ch1v: 2.1, dendro_ratio: 0.52, saturated: state === 'saturated' ? 1 : 0, saturation_side: state === 'saturated' ? 'high' : null }));
  };
  const props = { deveui: 'A840410000000001', deviceName: 'Local fixture with a long device label for narrow viewports', onClose: () => {} };
  const device = { deveui: props.deveui, name: props.deviceName, latest_data: { swt_1: 25, swt_2: 30, light_lux: 1234, ambient_temperature: 22.3, relative_humidity: 55 }, type_id: 'KIWI_SENSOR' } as Device;
  const content = surface === 'kiwi' ? <KiwiSensorCard device={device} removeContext="farm" readOnly /> : surface === 'rain' ? <RainMonitor {...props} /> : surface === 'dendrometer' ? <DendrometerMonitor {...props} strokeMm={5} /> : surface === 'analysis' ? <div style={{ height: 400 }}><EChart option={{ animation: false, legend: {}, xAxis: {}, yAxis: {}, series: [{ name: 'Line fixture', type: 'line', data: [[0, 1], [1, 2], [2, 1]] }, { name: 'Scatter fixture', type: 'scatter', data: [[0, 2], [1, 3], [2, 2]] }] }} /></div> : <WindMonitor {...props} />;
  createRoot(document.getElementById('root')!).render(<I18nextProvider i18n={i18n}>{content}</I18nextProvider>);
  // Reproduces live language switching without rebuilding or reloading the monitor.
  Object.assign(window, { b2Fixture: { changeLanguage: (lng: string) => i18n.changeLanguage(lng) } });
});
