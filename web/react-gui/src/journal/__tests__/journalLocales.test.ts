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
  'capture.form.growingSetting',
  'capture.form.increase',
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
  'capture.where.growingSetting',
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
  ])('%s carries the accepted English capture fallback', (_locale, resource) => {
    expect(resource.capture).toEqual(en.capture);
  });
});
