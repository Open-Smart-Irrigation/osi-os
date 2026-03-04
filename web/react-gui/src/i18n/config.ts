import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import HttpBackend from 'i18next-http-backend';

export const SUPPORTED_LANGUAGES = [
  { code: 'en',    label: 'English' },
  { code: 'de-CH', label: 'Deutsch (CH)' },
  { code: 'fr',    label: 'Français' },
] as const;

export type SupportedLanguageCode = typeof SUPPORTED_LANGUAGES[number]['code'];

i18n
  .use(HttpBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LANGUAGES.map(l => l.code),
    defaultNS: 'common',
    ns: ['common', 'auth', 'dashboard', 'devices'],
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'i18n_language',
      caches: ['localStorage'],
    },
    backend: {
      loadPath: '/gui/locales/{{lng}}/{{ns}}.json',
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: true },
  });

export default i18n;
