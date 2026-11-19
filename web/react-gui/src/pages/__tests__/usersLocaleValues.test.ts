// The Users page keys exist in every edge locale. lg ships the English
// source text until a human Luganda pass (docs/i18n/pending-luganda-translations.md).
import { describe, expect, it } from 'vitest';
import deCH from '../../../public/locales/de-CH/settings.json';
import en from '../../../public/locales/en/settings.json';
import es from '../../../public/locales/es/settings.json';
import fr from '../../../public/locales/fr/settings.json';
import itLocale from '../../../public/locales/it/settings.json';
import lg from '../../../public/locales/lg/settings.json';
import pt from '../../../public/locales/pt/settings.json';

const LEGACY_KEYS = ['linkedSignIn', 'linkedResetGuidance', 'signInUnknown', 'linkedResetRefused', 'resetError', 'resetRefreshFailed'];
const TRANSLATED: Record<string, unknown> = { 'de-CH': deCH, es, fr, it: itLocale, pt };
// B24 owns the human Luganda pass. Pending Users keys are recorded in
// docs/i18n/pending-luganda-translations.md, including UI FIX-LIST B3.
// Remove the allowlist entry and ledger row together after human translation.
const PENDING_HUMAN_LUGANDA = new Set(Object.keys(en.users));

function users(resource: unknown): Record<string, unknown> {
  const block = (resource as { users?: unknown }).users;
  expect(block && typeof block === 'object').toBe(true);
  return block as Record<string, unknown>;
}

describe('Users page locale values', () => {
  it('has the English Users keys and matching interpolation in every locale', () => {
    function leaves(resource: Record<string, unknown>, prefix = ''): Record<string, string> {
      return Object.fromEntries(Object.entries(resource).flatMap(([key, value]) => {
        const path = prefix ? `${prefix}.${key}` : key;
        return typeof value === 'string' ? [[path, value]] : Object.entries(leaves(value as Record<string, unknown>, path));
      }));
    }
    const baseline = leaves(users(en));
    for (const [name, resource] of Object.entries({ en, lg, ...TRANSLATED })) {
      const block = leaves(users(resource));
      expect(Object.keys(block).sort(), name).toEqual(Object.keys(baseline).sort());
      for (const [key, value] of Object.entries(block)) {
        expect(value.trim(), `${name} ${key}`).not.toBe('');
        expect(value.match(/{{\w+}}/g) ?? [], `${name} ${key} interpolation`).toEqual(baseline[key].match(/{{\w+}}/g) ?? []);
      }
    }
    expect(baseline.roleFor).toContain('{{username}}');
    expect(baseline.resetFor).toContain('{{username}}');
  });

  it('supplies localized form and action labels in the European locales', () => {
    for (const [name, resource] of Object.entries(TRANSLATED)) {
      for (const key of ['title', 'createUser', 'temporaryPassword', 'resetPassword', 'passwordMismatch', 'scrollHint']) {
        expect(users(resource)[key], `${name} ${key}`).not.toBe(users(en)[key]);
      }
    }
  });

  it('translates every key outside lg and keeps Swiss spelling', () => {
    for (const [name, resource] of Object.entries(TRANSLATED)) {
      for (const key of LEGACY_KEYS) expect(users(resource)[key], `${name} ${key}`).not.toBe(users(en)[key]);
    }
    expect(Object.values(users(deCH)).filter((value) => String(value).includes('ß'))).toEqual([]);
  });

  it('keeps pending lg keys byte-identical to en', () => {
    for (const key of PENDING_HUMAN_LUGANDA) expect(users(lg)[key], key).toEqual(users(en)[key]);
  });
});
