import i18n, {type Resource, type ResourceKey} from 'i18next';
import {initReactI18next} from 'react-i18next';
export const SUPPORTED_LANGUAGES = [{code: 'en', label: 'English'}, {code: 'fr', label: 'Français'}] as const;
export type SupportedLanguageCode = typeof SUPPORTED_LANGUAGES[number]['code'];
const files = import.meta.glob('../public/locales/{en,fr}/*.json', {eager: true, import: 'default'});
const resources: Resource = {en: {}, fr: {}};
for (const [path, json] of Object.entries(files)) {
  const [, language, namespace] = path.match(/locales\/(en|fr)\/(.+)\.json$/)!;
  resources[language][namespace] = json as ResourceKey;
}
void i18n.use(initReactI18next).init({resources, lng: 'en', fallbackLng: 'en', supportedLngs: ['en', 'fr'],
  defaultNS: 'common', fallbackNS: ['common'], interpolation: {escapeValue: false}, react: {useSuspense: false}});
export default i18n;
