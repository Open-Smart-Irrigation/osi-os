// #521: the Users page keys exist in every edge locale. lg ships the English
// source text until a human Luganda pass (docs/i18n/pending-luganda-translations.md).
import { describe, expect, it } from 'vitest';
import deCH from '../../../public/locales/de-CH/settings.json';
import en from '../../../public/locales/en/settings.json';
import es from '../../../public/locales/es/settings.json';
import fr from '../../../public/locales/fr/settings.json';
import itLocale from '../../../public/locales/it/settings.json';
import lg from '../../../public/locales/lg/settings.json';
import pt from '../../../public/locales/pt/settings.json';

const KEYS = ['linkedSignIn', 'linkedResetGuidance', 'signInUnknown', 'linkedResetRefused', 'resetError', 'resetRefreshFailed'];
const TRANSLATED: Record<string, unknown> = { 'de-CH': deCH, es, fr, it: itLocale, pt };
// Remove a key here and its row in docs/i18n/pending-luganda-translations.md
// together when a human supplies the Luganda text.
const PENDING_HUMAN_LUGANDA = new Set(KEYS);

function users(resource: unknown): Record<string, unknown> {
  const block = (resource as { users?: unknown }).users;
  expect(block && typeof block === 'object').toBe(true);
  return block as Record<string, unknown>;
}

describe('Users page locale values', () => {
  it('has exactly the six keys as non-empty plain strings in every locale', () => {
    for (const [name, resource] of Object.entries({ en, lg, ...TRANSLATED })) {
      const block = users(resource);
      expect(Object.keys(block).sort(), name).toEqual([...KEYS].sort());
      for (const key of KEYS) {
        expect(typeof block[key] === 'string' && (block[key] as string).trim() !== '', `${name} ${key}`).toBe(true);
        expect(block[key] as string, `${name} ${key} has no placeholder`).not.toMatch(/[{}]/);
      }
    }
  });

  it('translates every key outside lg and keeps Swiss spelling', () => {
    for (const [name, resource] of Object.entries(TRANSLATED)) {
      for (const key of KEYS) expect(users(resource)[key], `${name} ${key}`).not.toBe(users(en)[key]);
    }
    expect(Object.values(users(deCH)).filter((value) => String(value).includes('ß'))).toEqual([]);
  });

  it('keeps pending lg keys byte-identical to en', () => {
    for (const key of PENDING_HUMAN_LUGANDA) expect(users(lg)[key], key).toBe(users(en)[key]);
  });
});
