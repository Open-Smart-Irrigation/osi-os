import logoDeHoch from '../assets/agroscope/logo-de-hoch.png';
import logoEnHoch from '../assets/agroscope/logo-en-hoch.png';
import logoFrHoch from '../assets/agroscope/logo-fr-hoch.png';
import logoItHoch from '../assets/agroscope/logo-it-hoch.png';
import balkenHorizontalDe from '../assets/agroscope/balken-horizontal-de.png';
import balkenHorizontalEn from '../assets/agroscope/balken-horizontal-en.png';
import balkenHorizontalFr from '../assets/agroscope/balken-horizontal-fr.png';
import balkenHorizontalIt from '../assets/agroscope/balken-horizontal-it.png';

export type AgroscopeAssetLocale = 'en' | 'de' | 'fr' | 'it';

export interface AgroscopeBrandAssets {
  locale: AgroscopeAssetLocale;
  logoHoch: string;
  balkenHorizontal: string;
}

export const AGROLINK_BRAND = {
  productName: 'AgroLink',
  dashboardTitle: 'AgroLink Dashboard',
  loginSubtitle: 'Powered by OSI OS',
  ssidPrefix: 'AgroLink',
  zoneLabel: 'Zone',
  zonesLabel: 'Zones',
  colors: {
    agroscopeRed: '#E30613',
    agroscopeBlack: '#040404',
  },
} as const;

const AGROSCOPE_ASSETS: Record<AgroscopeAssetLocale, AgroscopeBrandAssets> = {
  en: {
    locale: 'en',
    logoHoch: logoEnHoch,
    balkenHorizontal: balkenHorizontalEn,
  },
  de: {
    locale: 'de',
    logoHoch: logoDeHoch,
    balkenHorizontal: balkenHorizontalDe,
  },
  fr: {
    locale: 'fr',
    logoHoch: logoFrHoch,
    balkenHorizontal: balkenHorizontalFr,
  },
  it: {
    locale: 'it',
    logoHoch: logoItHoch,
    balkenHorizontal: balkenHorizontalIt,
  },
};

export function resolveAgroscopeAssetLocale(language?: string | null): AgroscopeAssetLocale {
  const normalized = String(language ?? '').trim().toLowerCase();

  if (normalized.startsWith('de')) return 'de';
  if (normalized.startsWith('fr')) return 'fr';
  if (normalized.startsWith('it')) return 'it';

  return 'en';
}

export function resolveAgroscopeAssets(language?: string | null): AgroscopeBrandAssets {
  return AGROSCOPE_ASSETS[resolveAgroscopeAssetLocale(language)];
}
