import { describe, expect, it } from 'vitest';

import deCH from '../../../public/locales/de-CH/journal.json';
import en from '../../../public/locales/en/journal.json';
import es from '../../../public/locales/es/journal.json';
import fr from '../../../public/locales/fr/journal.json';
import itLocale from '../../../public/locales/it/journal.json';
import lg from '../../../public/locales/lg/journal.json';
import pt from '../../../public/locales/pt/journal.json';

function keyShape(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    keyShape(child, prefix ? `${prefix}.${key}` : key));
}

describe('journal locale parity', () => {
  it.each([
    ['de-CH', deCH],
    ['es', es],
    ['fr', fr],
    ['it', itLocale],
    ['lg', lg],
    ['pt', pt],
  ])('%s matches the English key shape', (_locale, resource) => {
    expect(keyShape(resource).sort()).toEqual(keyShape(en).sort());
  });
});
