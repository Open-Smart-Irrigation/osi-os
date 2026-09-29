import i18n, {type Resource, type ResourceKey} from 'i18next';
import lugandaValves from './locales/lg-valves.json';
import {WATER_COPY} from './water-copy';
import {initReactI18next} from 'react-i18next';
export const SUPPORTED_LANGUAGES = [
  {code: 'en', label: 'English'}, {code: 'de-CH', label: 'Deutsch'},
  {code: 'fr', label: 'Français'}, {code: 'it', label: 'Italiano'},
  {code: 'es', label: 'Español'}, {code: 'pt', label: 'Português'},
  {code: 'lg', label: 'Luganda'},
] as const;
export type SupportedLanguageCode = typeof SUPPORTED_LANGUAGES[number]['code'];
const files = import.meta.glob('../public/locales/*/*.json', {eager: true, import: 'default'});
const resources: Resource = Object.fromEntries(SUPPORTED_LANGUAGES.map(({code}) => [code, {}]));
for (const [path, json] of Object.entries(files)) {
  const [, language, namespace] = path.match(/locales\/([^/]+)\/(.+)\.json$/)!;
  if (resources[language]) resources[language][namespace] = structuredClone(json) as ResourceKey;
}
// Demo copy only; keep each shipped translation and its existing English fallbacks.
for (const [language, resource] of Object.entries(resources)) {
  const dashboard = resource.dashboard as {title: string};
  dashboard.title = dashboard.title.replace('Open Smart Irrigation', 'OSI OS');
  const water = (resource.devices as {zone: {water: {subtitle: string; rainToday: string; measured: string; drivenByBalance: string}}}).zone.water;
  water.measured = WATER_COPY[language].measured;
  water.drivenByBalance = WATER_COPY[language].advice;
  water.subtitle = `${water.rainToday} · ${water.measured}`;
}
void i18n.use(initReactI18next).init({resources, lng: 'en', fallbackLng: 'en', supportedLngs: SUPPORTED_LANGUAGES.map(({code}) => code),
  defaultNS: 'common', fallbackNS: ['common'], interpolation: {escapeValue: false}, react: {useSuspense: false}});
// Keep machine-translated Luganda scoped to this build; never edit production copy.
for (const [key, value] of Object.entries(lugandaValves)) i18n.addResource('lg', 'valves', key, value);
for (const {code} of SUPPORTED_LANGUAGES) i18n.addResource(code, 'settings', 'valveControl', i18n.t('title', {ns:'valves',lng:code}));
export default i18n;
