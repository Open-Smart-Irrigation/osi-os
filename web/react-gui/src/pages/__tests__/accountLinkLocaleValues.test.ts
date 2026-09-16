import { describe, expect, it } from 'vitest';
import deCH from '../../../public/locales/de-CH/accountLink.json';
import en from '../../../public/locales/en/accountLink.json';
import es from '../../../public/locales/es/accountLink.json';
import fr from '../../../public/locales/fr/accountLink.json';
import itLocale from '../../../public/locales/it/accountLink.json';
import lg from '../../../public/locales/lg/accountLink.json';
import pt from '../../../public/locales/pt/accountLink.json';

const LOCALES = ['de-CH', 'es', 'fr', 'it', 'lg', 'pt'] as const;
type Locale = (typeof LOCALES)[number];
const LOCALE_RESOURCES: Record<string, unknown> = { en, 'de-CH': deCH, es, fr, it: itLocale, lg, pt };

function flattenLeaves(value: unknown, prefix = '', leaves: Record<string, string> = {}): Record<string, string> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      flattenLeaves(child, prefix ? `${prefix}.${key}` : key, leaves);
    }
  } else if (typeof value === 'string' && value.trim() !== '') {
    placeholders(value);
    leaves[prefix] = value;
  } else {
    throw new Error(`invalid accountLink locale leaf at ${prefix || '<root>'}`);
  }
  return leaves;
}

function localeLeaves(locale: string): Record<string, string> {
  return flattenLeaves(LOCALE_RESOURCES[locale]);
}

function placeholders(value: string): string[] {
  const matches: string[] = [];
  let index = 0;

  while (index < value.length) {
    const open = value.indexOf('{', index);
    const close = value.indexOf('}', index);
    if (open === -1 && close === -1) break;
    if (close !== -1 && (open === -1 || close < open)) {
      throw new Error(`malformed interpolation braces in ${JSON.stringify(value)}`);
    }
    if (!value.startsWith('{{', open)) {
      throw new Error(`malformed interpolation braces in ${JSON.stringify(value)}`);
    }

    const end = value.indexOf('}}', open + 2);
    const name = end === -1 ? '' : value.slice(open + 2, end);
    if (end === -1 || !/^\S+$/.test(name) || /[{}]/.test(name)) {
      throw new Error(`malformed interpolation braces in ${JSON.stringify(value)}`);
    }

    matches.push(value.slice(open, end + 2));
    index = end + 2;
  }

  return matches.sort();
}

// Intentionally key-specific: a shared value is legitimate only at a reviewed
// leaf where it is a proper name, brand token, or genuine cross-language
// cognate (e.g. "OSI Server", "Email"/"Password" as commonly borrowed tech
// words). Every other identical-to-en leaf in this namespace is untranslated
// and must fail this guard.
const REVIEWED_IDENTICAL_KEYS: Record<Locale, ReadonlySet<string>> = {
  'de-CH': new Set(['navLink', 'form.serverUrl']),
  es: new Set(['navLink']),
  fr: new Set(['navLink', 'form.actionLabel', 'warning.title']),
  it: new Set(['navLink', 'form.email', 'form.password']),
  lg: new Set(['navLink', 'form.email']),
  pt: new Set(['navLink']),
};

// Distinct from REVIEWED_IDENTICAL_KEYS above: these are not cognates, they
// are keys where the previously shipped Luganda became a stale/incorrect
// translation of an English string that has since changed meaning, and no
// corrected human Luganda text exists yet. Shipping the current English text
// verbatim (an honest fallback) is preferred over leaving the old, now-wrong
// translation in place or inventing an unreviewed one. See
// docs/i18n/pending-luganda-translations.md for the tracked list and reason
// per key; a human Luganda pass must remove the key from this set when it
// lands.
const PENDING_HUMAN_TRANSLATION: Partial<Record<Locale, ReadonlySet<string>>> = {
  lg: new Set(['warning.message']),
};

function isReviewedIdentical(locale: Locale, key: string): boolean {
  return REVIEWED_IDENTICAL_KEYS[locale].has(key) || (PENDING_HUMAN_TRANSLATION[locale]?.has(key) ?? false);
}

describe('accountLink locale value parity', () => {
  it('keeps all six locales translated except reviewed shared technical values', () => {
    const english = localeLeaves('en');

    for (const locale of LOCALES) {
      const translated = localeLeaves(locale);
      const englishKeys = new Set(Object.keys(english));
      const translatedKeys = new Set(Object.keys(translated));
      expect([...translatedKeys].filter((key) => !englishKeys.has(key)), `${locale} extra keys`).toEqual([]);
      expect([...englishKeys].filter((key) => !translatedKeys.has(key)), `${locale} missing keys`).toEqual([]);

      const allAllowlistKeys = [...REVIEWED_IDENTICAL_KEYS[locale], ...(PENDING_HUMAN_TRANSLATION[locale] ?? [])];
      const missingAllowlistKeys = allAllowlistKeys.filter((key) =>
        !Object.prototype.hasOwnProperty.call(english, key) || !Object.prototype.hasOwnProperty.call(translated, key));
      expect(missingAllowlistKeys, `${locale} allowlisted keys missing from a locale resource`).toEqual([]);

      const identicalKeys = Object.keys(english).filter((key) => translated[key] === english[key]);
      const unexpected = identicalKeys.filter((key) => !isReviewedIdentical(locale, key));
      const staleAllowlist = allAllowlistKeys.filter((key) => translated[key] !== english[key]);
      expect(unexpected, `${locale} unreviewed English-identical values`).toEqual([]);
      expect(staleAllowlist, `${locale} stale identical-value allowlist entries`).toEqual([]);

      const placeholderMismatches = Object.keys(english).filter((key) =>
        placeholders(english[key]).join('|') !== placeholders(translated[key]).join('|'));
      expect(placeholderMismatches, `${locale} placeholder mismatches`).toEqual([]);
    }
  });

  it('uses Swiss spelling in de-CH', () => {
    const german = localeLeaves('de-CH');
    expect(Object.values(german).filter((value) => value.includes('ß'))).toEqual([]);
  });

  it('rejects non-string and empty leaves instead of coercing them', () => {
    for (const invalid of [null, 42, false, '']) {
      expect(() => flattenLeaves({ invalid })).toThrow(/invalid accountLink locale leaf/);
    }
  });
});
