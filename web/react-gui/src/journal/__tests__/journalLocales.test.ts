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

function flatten(value: unknown, prefix = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[prefix, value]];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    flatten(child, prefix ? `${prefix}.${key}` : key));
}

/**
 * Keys whose translated value is legitimately identical to English, reviewed one
 * by one. Anything else identical is an untranslated string, not a translation.
 *
 * This shape exists because key-presence parity cannot see the bug it replaced:
 * `journal.json` shipped a complete key tree whose values were all English, and
 * the test here asserted `resource.capture` *equalled* English — pinning the
 * placeholder in place. Assert on values, and make every shared string explicit.
 */
/**
 * "Layout" is deliberately the same word in every locale (product decision
 * 2026-07-16). A layout is a neutral, extensible container — v1 happens to ship
 * cultivation settings (open field, greenhouse, lysimeter), but a future layout
 * may mean something else entirely, so the label must not bake "growing" into
 * it. It was previously "Growing setting", which no locale could translate
 * consistently: "setting" reads as either configuration or environment, and the
 * six translators split evenly between those two meanings.
 */
const LAYOUT_KEYS = ['capture.confirm.layout', 'capture.form.layout', 'capture.where.layout'];

const SHARED_WITH_ENGLISH: Record<string, readonly string[]> = {
  // Fertigation: international agronomic loanword, unchanged even in de-CH, which
  // otherwise translates freely (Fertilization -> Düngung). Optional/Details:
  // genuine German words. Final: the record-state loanword, beside Entwurf/Storniert.
  'de-CH': [...LAYOUT_KEYS, 'activity.fertigation', 'capture.confirm.values', 'capture.form.optional', 'row.status.final'],
  // Irrigation/Fertigation/Observation are spelled identically in French; Final
  // agrees with the implicit masculine "statut", beside Brouillon/Annulé.
  fr: [...LAYOUT_KEYS, 'activity.fertigation', 'activity.general_observation', 'activity.irrigation', 'row.status.final'],
  // "Note" (pl. of nota) and "No" are the correct Italian words.
  it: [...LAYOUT_KEYS, 'capture.form.booleanNo', 'capture.form.note'],
  // "No" is identical in Spanish.
  es: [...LAYOUT_KEYS, 'capture.form.booleanNo'],
  // "Final" is the correct Portuguese word for this record state.
  pt: [...LAYOUT_KEYS, 'row.status.final'],
  // Fertigation has no vernacular Luganda equivalent; Timezone is a computing
  // term the shipped lg files also leave in English.
  lg: [...LAYOUT_KEYS, 'activity.fertigation', 'capture.where.timezone'],
};

const REQUIRED_CAPTURE_KEYS = [
  'capture.back',
  'capture.carry.dismiss',
  'capture.carry.crop',
  'capture.carry.invalidated',
  'capture.carry.prefilled',
  'capture.carry.product',
  'capture.carry.rate',
  'capture.carry.repeatTreatment',
  'capture.carry.repeatTreatmentDescription',
  'capture.carry.sourceDate',
  'capture.carry.useValues',
  'capture.close',
  'capture.confirm.activity',
  'capture.confirm.duplicateBody',
  'capture.confirm.duplicateTitle',
  'capture.confirm.edit',
  'capture.confirm.farmLevel',
  'capture.confirm.layout',
  'capture.confirm.occurrence',
  'capture.confirm.openExisting',
  'capture.confirm.plot',
  'capture.confirm.ready',
  'capture.confirm.saveSeparately',
  'capture.confirm.title',
  'capture.confirm.values',
  'capture.finish',
  'capture.form.add',
  'capture.form.booleanNo',
  'capture.form.booleanYes',
  'capture.form.decrease',
  'capture.form.derivedNutrients',
  'capture.form.detailLevel',
  'capture.form.full',
  'capture.form.increase',
  'capture.form.layout',
  'capture.form.noProducts',
  'capture.form.note',
  'capture.form.optional',
  'capture.form.product',
  'capture.form.quick',
  'capture.form.remove',
  'capture.form.required',
  'capture.form.research',
  'capture.form.select',
  'capture.form.title',
  'capture.form.unit',
  'capture.form.value',
  'capture.next',
  'capture.picker.allOptions',
  'capture.picker.browseAll',
  'capture.picker.commonThisSeason',
  'capture.picker.farmRecent',
  'capture.picker.more',
  'capture.picker.noResults',
  'capture.picker.recentOnPlot',
  'capture.picker.search',
  'capture.picker.searchPlaceholder',
  'capture.picker.title',
  'capture.picker.unsupported',
  'capture.save.cloudWaiting',
  'capture.save.draftSavedGateway',
  'capture.save.finalSavedGateway',
  'capture.save.leaveWarning',
  'capture.save.lossWarning',
  'capture.save.notSaved',
  'capture.save.retry',
  'capture.save.saving',
  'capture.title',
  'capture.validation.ambiguousLocalTime',
  'capture.validation.chooseUtcOffset',
  'capture.validation.cropRequired',
  'capture.validation.crossBasis',
  'capture.validation.incompatibleUnit',
  'capture.validation.invalidDefinition',
  'capture.validation.invalidDependency',
  'capture.validation.invalidLocalTime',
  'capture.validation.invalidNumber',
  'capture.validation.invalidTimezone',
  'capture.validation.invalidUtcOffset',
  'capture.validation.layoutTemplateMismatch',
  'capture.validation.maximum',
  'capture.validation.minimum',
  'capture.validation.nonexistentLocalTime',
  'capture.validation.required',
  'capture.where.farmLevel',
  'capture.where.layout',
  'capture.where.linkedZone',
  'capture.where.noPlot',
  'capture.where.plot',
  'capture.where.selectPlot',
  'capture.where.sensorless',
  'capture.where.timezone',
  'capture.where.title',
] as const;

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

  it('owns the complete Phase 3 capture key tree', () => {
    const captureKeys = keyShape(en)
      .filter((key) => key.startsWith('capture.'))
      .sort();

    expect(captureKeys).toEqual([...REQUIRED_CAPTURE_KEYS].sort());
  });

  it.each([
    ['de-CH', deCH],
    ['es', es],
    ['fr', fr],
    ['it', itLocale],
    ['lg', lg],
    ['pt', pt],
  ])('%s translates every string it does not legitimately share with English', (locale, resource) => {
    const english = new Map(flatten(en));
    const identical = flatten(resource)
      .filter(([key, value]) => english.get(key) === value)
      .map(([key]) => key)
      .sort();

    expect(identical).toEqual([...SHARED_WITH_ENGLISH[locale]].sort());
  });

  it('keeps de-CH in Swiss orthography', () => {
    const violations = flatten(deCH).filter(([, value]) => value.includes('ß'));

    expect(violations).toEqual([]);
  });

  it.each([
    ['de-CH', deCH],
    ['es', es],
    ['fr', fr],
    ['it', itLocale],
    ['lg', lg],
    ['pt', pt],
  ])('%s preserves every interpolation placeholder', (_locale, resource) => {
    const placeholders = (value: string) => (value.match(/{{\s*\w+\s*}}/g) ?? []).sort();
    const translated = new Map(flatten(resource));
    const mismatched = flatten(en)
      .filter(([key, value]) =>
        placeholders(value).join() !== placeholders(translated.get(key) ?? '').join())
      .map(([key]) => key);

    expect(mismatched).toEqual([]);
  });
});
