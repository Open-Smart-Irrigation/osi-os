import { describe, expect, it } from 'vitest';
import en from '../../../../../public/locales/en/valves.json';
import deCH from '../../../../../public/locales/de-CH/valves.json';
import fr from '../../../../../public/locales/fr/valves.json';
import itLocale from '../../../../../public/locales/it/valves.json';
import es from '../../../../../public/locales/es/valves.json';
import pt from '../../../../../public/locales/pt/valves.json';
import lg from '../../../../../public/locales/lg/valves.json';

const LOCALES = ['en', 'de-CH', 'fr', 'it', 'es', 'pt', 'lg'] as const;
const LOCALE_RESOURCES: Record<string, Record<string, unknown>> = { en, 'de-CH': deCH, fr, it: itLocale, es, pt, lg };

function readLocale(locale: string): Record<string, unknown> { return LOCALE_RESOURCES[locale]; }

function paths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return prefix ? [prefix] : [];
  return Object.entries(value).flatMap(([key, child]) => paths(child, prefix ? `${prefix}.${key}` : key));
}

function atPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => (
    current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined
  ), value);
}

describe('valves locale bundles', () => {
  it('keep every locale path and value type aligned with English', () => {
    const english = readLocale('en');
    const expectedPaths = paths(english).sort();
    for (const locale of LOCALES) {
      const translated = readLocale(locale);
      expect(paths(translated).sort(), `${locale} key paths`).toEqual(expectedPaths);
      for (const path of expectedPaths) {
        expect(typeof atPath(translated, path), `${locale} ${path} value type`).toBe(typeof atPath(english, path));
      }
    }
  });

  it('keeps SWT thresholds and Recommended in Moist help only', () => {
    const english = readLocale('en');
    const preference = atPath(english, 'irrigationPreference') as Record<string, any>;
    expect(preference.wet.thresholdKpa).toBe(20);
    expect(preference.moist.thresholdKpa).toBe(30);
    expect(preference.dry.thresholdKpa).toBe(50);
    expect(preference.moist.help).toContain('Recommended.');
    expect(preference.wet.help).not.toContain('Recommended.');
    expect(preference.dry.help).not.toContain('Recommended.');
    expect(preference.wet.label).toBe('Wet');
    expect(preference.moist.label).toBe('Moist');
    expect(preference.dry.label).toBe('Dry');
    expect(preference.custom).toBe('Custom');
    expect(preference.advanced).toBe('Advanced');
    expect(preference.editSchedule).toBe('Edit schedule');
  });
});
