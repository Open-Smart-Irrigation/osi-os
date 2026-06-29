import { describe, expect, it } from 'vitest';
import {
  AGROLINK_BRAND,
  resolveAgroscopeAssetLocale,
  resolveAgroscopeAssets,
} from '../agrolink';

function basename(src: string): string {
  return src.split('/').pop() ?? src;
}

describe('AgroLink brand config', () => {
  it('exposes approved product copy', () => {
    expect(AGROLINK_BRAND.productName).toBe('AgroLink');
    expect(AGROLINK_BRAND.dashboardTitle).toBe('AgroLink Dashboard');
    expect(AGROLINK_BRAND.loginSubtitle).toBe('Powered by OSI OS');
    expect(AGROLINK_BRAND.ssidPrefix).toBe('AgroLink');
    expect(AGROLINK_BRAND.zoneLabel).toBe('Zone');
    expect(AGROLINK_BRAND.zonesLabel).toBe('Zones');
  });

  it('maps supported GUI languages to official Agroscope asset locales', () => {
    expect(resolveAgroscopeAssetLocale('en')).toBe('en');
    expect(resolveAgroscopeAssetLocale('de-CH')).toBe('de');
    expect(resolveAgroscopeAssetLocale('de')).toBe('de');
    expect(resolveAgroscopeAssetLocale('fr')).toBe('fr');
    expect(resolveAgroscopeAssetLocale('it')).toBe('it');
  });

  it('falls back to English assets for unsupported or missing languages', () => {
    expect(resolveAgroscopeAssetLocale('es')).toBe('en');
    expect(resolveAgroscopeAssetLocale('pt')).toBe('en');
    expect(resolveAgroscopeAssetLocale('lg')).toBe('en');
    expect(resolveAgroscopeAssetLocale(undefined)).toBe('en');
    expect(resolveAgroscopeAssetLocale(null)).toBe('en');
  });

  it('returns imported logo and horizontal Balken assets', () => {
    expect(basename(resolveAgroscopeAssets('en').logoHoch)).toContain('logo-en-hoch');
    expect(basename(resolveAgroscopeAssets('de-CH').logoHoch)).toContain('logo-de-hoch');
    expect(basename(resolveAgroscopeAssets('fr').logoHoch)).toContain('logo-fr-hoch');
    expect(basename(resolveAgroscopeAssets('it').logoHoch)).toContain('logo-it-hoch');
    expect(basename(resolveAgroscopeAssets('es').balkenHorizontal)).toContain('balken-horizontal-en');
  });
});
