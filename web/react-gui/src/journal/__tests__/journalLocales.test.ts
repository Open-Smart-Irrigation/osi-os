import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import i18next, { type i18n as I18n } from 'i18next';

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

function valueAtPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
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
const LAYOUT_KEYS = ['capture.confirm.layout', 'capture.form.layout', 'capture.where.layout', 'plot.layout'];
// The summary is a locale-neutral interpolation template; its inserted labels
// carry the grammar, so this structural value is intentionally shared.
const SHARED_STRUCTURE_KEYS = ['where.rangeSummary'];

const SHARED_WITH_ENGLISH: Record<string, readonly string[]> = {
  // Task 24 group-resolution and plural values are translated in every
  // non-English locale, so this change adds no new shared values.
  // Fertigation: international agronomic loanword, unchanged even in de-CH, which
  // otherwise translates freely (Fertilization -> Düngung). Optional/Details:
  // genuine German words. Final: the record-state loanword, beside Entwurf/Storniert.
  // Name, Zone, and Station are the legitimate English-identical field labels in de-CH.
  // Status (Task 28 workspace filter, and the Task 29 entry-table column of
  // the same name) is the same loanword in German too.
  'de-CH': [...LAYOUT_KEYS, ...SHARED_STRUCTURE_KEYS, 'activity.fertigation', 'capture.confirm.values', 'capture.form.optional', 'row.status.final', 'plot.name', 'plot.station', 'plot.zone', 'where.station', 'filters.status', 'workspace.table.column.status'],
  // Irrigation/Fertigation/Observation are spelled identically in French; Final
  // agrees with the implicit masculine "statut", beside Brouillon/Annulé.
  // Zone, Station, and Active are the legitimate English-identical French labels;
  // the Task 28 workspace "Stations" heading is the same plural.
  fr: [...LAYOUT_KEYS, ...SHARED_STRUCTURE_KEYS, 'activity.fertigation', 'activity.general_observation', 'activity.irrigation', 'row.status.final', 'plot.active', 'plot.station', 'plot.zone', 'where.station', 'workspace.scope.stations'],
  // "Note" (pl. of nota) and "No" are the correct Italian words.
  it: [...LAYOUT_KEYS, ...SHARED_STRUCTURE_KEYS, 'capture.form.booleanNo', 'capture.form.note'],
  // "No" is identical in Spanish; singular "sensor" (Task 28 workspace scope) is
  // spelled the same in Spanish as in English.
  es: [...LAYOUT_KEYS, ...SHARED_STRUCTURE_KEYS, 'capture.form.booleanNo', 'workspace.scope.sensors_one'],
  // "Final" is the correct Portuguese word for this record state; singular
  // "sensor" (Task 28 workspace scope) is spelled the same in Portuguese.
  pt: [...LAYOUT_KEYS, ...SHARED_STRUCTURE_KEYS, 'row.status.final', 'workspace.scope.sensors_one'],
  // Fertigation has no vernacular Luganda equivalent; Timezone is a computing
  // term the shipped lg files also leave in English. Campaign, Protocol, and
  // Sensor(s) (Task 28 workspace filters/scope) follow the same precedent —
  // no established Luganda term, kept as the source English word. Task 30's
  // detail-panel field labels for the same two concepts (campaign, protocol)
  // follow the identical precedent already set by the filters above.
  lg: [...LAYOUT_KEYS, ...SHARED_STRUCTURE_KEYS, 'activity.fertigation', 'capture.where.timezone', 'filters.campaign', 'filters.protocol', 'workspace.detail.field.campaign_uuid', 'workspace.detail.field.protocol_code', 'workspace.scope.sensors'],
};

const REQUIRED_CAPTURE_KEYS = [
  'capture.back',
  'capture.carry.dismiss',
  'capture.carry.crop',
  'capture.carry.group',
  'capture.carry.invalidated',
  'capture.carry.prefilled',
  'capture.carry.product',
  'capture.carry.protectedValues',
  'capture.carry.rate',
  'capture.carry.repeatTreatment',
  'capture.carry.repeatTreatmentDescription',
  'capture.carry.sourceDate',
  'capture.carry.unknownProduct',
  'capture.carry.unknownRate',
  'capture.carry.unknownValue',
  'capture.carry.useValues',
  'capture.carry.valueStatus.observed',
  'capture.carry.valueStatus.not_observed',
  'capture.carry.valueStatus.not_applicable',
  'capture.carry.valueStatus.below_detection',
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
  'capture.transition.body',
  'capture.transition.close',
  'capture.transition.keep',
  'capture.transition.pendingBanner',
  'capture.transition.reasonChoiceInvalid',
  'capture.transition.reasonFieldHidden',
  'capture.transition.remove',
  'capture.transition.replace',
  'capture.transition.reviewAction',
  'capture.transition.title',
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

const REQUIRED_PHASE4_KEYS = [
  'where.station',
  'where.unstationed',
  'where.namedPlots',
  'where.noStation',
  'where.selectAll',
  'where.invert',
  'where.range',
  'where.applyRange',
  'where.rangeSummary',
  'where.rangePlotCount',
  'where.rangePlotCount_one',
  'where.rangePlotCount_other',
  'where.rangeSelectedCount',
  'where.rangeSelectedCount_one',
  'where.rangeSelectedCount_other',
  'where.rangeEmpty',
  'where.rangeMalformed',
  'where.rangeOutOfStation',
  'where.rangeDuplicate',
  'where.rangeReversed',
  'where.rangeNonInteger',
  'where.rangeNonPositive',
  'where.mixedLayout',
  'where.maxPlots',
  'where.maxPlotsError',
  'where.noPlot',
  'where.selectionCount',
  'where.selectionCount_one',
  'where.selectionCount_other',
  'where.staleSelection',
  'where.createGroup',
  'where.editGroup',
  'where.groupLabel',
  'where.saveGroup',
  'where.cancel',
  'where.loading',
  'where.retry',
  'group.members',
  'group.members_one',
  'group.members_other',
  'group.unavailableMembers',
  'group.resolved',
  'group.resolve',
  'group.resolveError',
  'group.changedError',
  'group.resolutionRegion',
  'group.resolveHeading',
  'group.resolveAction',
  'group.resolving',
  'group.heterogeneous',
  'group.create',
  'group.edit',
  'group.loading',
  'group.error',
  'group.retry',
  'plot.create',
  'plot.update',
  'plot.new',
  'plot.edit',
  'plot.code',
  'plot.name',
  'plot.zone',
  'plot.station',
  'plot.cropHint',
  'plot.area',
  'plot.active',
  'plot.layout',
  'plot.save',
  'plot.cancel',
  'plot.layoutRequired',
  'plot.stale',
  'plot.codeConflict',
  'plot.heterogeneousGroup',
  'plot.unresolvedGroup',
  'plot.loading',
  'plot.error',
  'plot.retry',
  'batch.saving',
  'batch.saved',
  'batch.confirm',
  'batch.confirmCount',
  'batch.confirmCount_one',
  'batch.confirmCount_other',
  'batch.duplicateTitle',
  'batch.duplicateBody',
  'batch.duplicateAcknowledge',
  'batch.count',
  'batch.count_one',
  'batch.count_other',
  'batch.retry',
  'timeline.batch',
  'timeline.batchExpand',
  'timeline.batchCollapse',
  'timeline.batchLoading',
  'timeline.batchError',
  'timeline.batchRetry',
] as const;

/**
 * These keys are selected through dynamic maps rather than literal t() calls.
 * Keep their map ownership explicit while the literal consumer set below is
 * extracted from the TypeScript source.
 */
const DYNAMIC_KEY_FAMILIES = {
  activityCodes: [
    'activity.fertigation',
    'activity.fertilization',
    'activity.general_observation',
    'activity.harvest',
    'activity.irrigation',
    'activity.seeding',
  ],
  rowStatuses: [
    'row.status.draft',
    'row.status.final',
    'row.status.voided',
  ],
  plotFormErrors: [
    'plot.codeConflict',
    'plot.heterogeneousGroup',
    'plot.stale',
    'plot.unresolvedGroup',
  ],
  rangeErrors: [
    'where.rangeDuplicate',
    'where.rangeEmpty',
    'where.rangeMalformed',
    'where.rangeNonInteger',
    'where.rangeNonPositive',
    'where.rangeOutOfStation',
    'where.rangeReversed',
  ],
  saveStates: [
    'capture.save.cloudWaiting',
    'capture.save.draftSavedGateway',
    'capture.save.finalSavedGateway',
    'capture.save.notSaved',
    'capture.save.saving',
  ],
  harvestGroupErrors: [
    'group.changedError',
    'group.resolveError',
  ],
  captureValidation: [
    'capture.validation.ambiguousLocalTime',
    'capture.validation.cropRequired',
    'capture.validation.invalidDefinition',
    'capture.validation.invalidLocalTime',
    'capture.validation.invalidNumber',
    'capture.validation.invalidTimezone',
    'capture.validation.maximum',
    'capture.validation.minimum',
    'capture.validation.nonexistentLocalTime',
  ],
} as const;

const DYNAMIC_MAP_KEYS = [
  ...DYNAMIC_KEY_FAMILIES.activityCodes,
  ...DYNAMIC_KEY_FAMILIES.rowStatuses,
  ...DYNAMIC_KEY_FAMILIES.plotFormErrors,
  ...DYNAMIC_KEY_FAMILIES.rangeErrors,
  ...DYNAMIC_KEY_FAMILIES.saveStates,
  ...DYNAMIC_KEY_FAMILIES.harvestGroupErrors,
  ...DYNAMIC_KEY_FAMILIES.captureValidation,
] as const;

const JOURNAL_SOURCE_MODULES: Record<string, string> = {
  ...import.meta.glob<string>('../../components/journal/**/*.{ts,tsx}', {
    eager: true,
    import: 'default',
    query: '?raw',
  }),
  ...import.meta.glob<string>('../../pages/JournalPage.tsx', {
    eager: true,
    import: 'default',
    query: '?raw',
  }),
};

function literalStrings(expression: ts.Expression): string[] {
  if (ts.isStringLiteralLike(expression)) return [expression.text];
  if (ts.isParenthesizedExpression(expression)) return literalStrings(expression.expression);
  if (ts.isConditionalExpression(expression)) {
    return [...literalStrings(expression.whenTrue), ...literalStrings(expression.whenFalse)];
  }
  return [];
}

function sourceConsumerKeys(): string[] {
  const keys = new Set<string>();
  for (const [file, contents] of Object.entries(JOURNAL_SOURCE_MODULES)) {
    if (file.includes('/__tests__/')) continue;
    const source = ts.createSourceFile(
      file,
      contents,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.arguments.length > 0) {
        const expression = node.expression;
        const isTranslationCall = ts.isIdentifier(expression) && expression.text === 't'
          || ts.isPropertyAccessExpression(expression) && expression.name.text === 't';
        if (isTranslationCall) {
          for (const value of literalStrings(node.arguments[0])) {
            const key = value.startsWith('journal:') ? value.slice('journal:'.length) : value;
            keys.add(key);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...keys].sort();
}

const PHASE4_INTERPOLATION_TOKENS: Record<string, readonly string[]> = {
  'where.rangeSummary': ['label', 'plotCount', 'selectedCount'],
  'where.maxPlotsError': ['count'],
  'where.selectionCount_one': ['count'],
  'where.selectionCount_other': ['count'],
  'where.rangePlotCount_one': ['count'],
  'where.rangePlotCount_other': ['count'],
  'where.rangeSelectedCount_one': ['count'],
  'where.rangeSelectedCount_other': ['count'],
  'batch.confirmCount_one': ['count'],
  'batch.confirmCount_other': ['count'],
  'batch.count_one': ['count'],
  'batch.count_other': ['count'],
  'group.members_one': ['count'],
  'group.members_other': ['count'],
};

const I18NEXT_INSTANCE_EVENTS = [
  'initialized',
  'loaded',
  'failedLoading',
  'languageChanging',
  'languageChanged',
  'missingKey',
] as const;

function cleanupJournalI18n(i18n: I18n, locale: string): void {
  i18n.removeResourceBundle(locale, 'journal');
  for (const event of I18NEXT_INSTANCE_EVENTS) i18n.off(event);
}

function interpolationTokens(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return [...value.matchAll(/{{\s*(\w+)\s*}}/g)].map(([, token]) => token).sort();
}

const STATION_RANGE_EXPECTED: Record<string, Record<string, string>> = {
  en: {
    '1:0': 'Station A · 1 plot · 0 selected',
    '1:1': 'Station A · 1 plot · 1 selected',
    '2:1': 'Station A · 2 plots · 1 selected',
    '2:2': 'Station A · 2 plots · 2 selected',
  },
  'de-CH': {
    '1:0': 'Station A · 1 Parzelle · 0 ausgewählt',
    '1:1': 'Station A · 1 Parzelle · 1 ausgewählt',
    '2:1': 'Station A · 2 Parzellen · 1 ausgewählt',
    '2:2': 'Station A · 2 Parzellen · 2 ausgewählt',
  },
  es: {
    '1:0': 'Station A · 1 parcela · 0 seleccionadas',
    '1:1': 'Station A · 1 parcela · 1 seleccionada',
    '2:1': 'Station A · 2 parcelas · 1 seleccionada',
    '2:2': 'Station A · 2 parcelas · 2 seleccionadas',
  },
  fr: {
    '1:0': 'Station A · 1 parcelle · 0 sélectionnée',
    '1:1': 'Station A · 1 parcelle · 1 sélectionnée',
    '2:1': 'Station A · 2 parcelles · 1 sélectionnée',
    '2:2': 'Station A · 2 parcelles · 2 sélectionnées',
  },
  it: {
    '1:0': 'Station A · 1 particella · 0 selezionate',
    '1:1': 'Station A · 1 particella · 1 selezionata',
    '2:1': 'Station A · 2 particelle · 1 selezionata',
    '2:2': 'Station A · 2 particelle · 2 selezionate',
  },
  lg: {
    '1:0': 'Station A · Omusiri 1 · Emisiri 0 girondeddwa',
    '1:1': 'Station A · Omusiri 1 · Omusiri 1 gulondeddwa',
    '2:1': 'Station A · Emisiri 2 · Omusiri 1 gulondeddwa',
    '2:2': 'Station A · Emisiri 2 · Emisiri 2 girondeddwa',
  },
  pt: {
    '1:0': 'Station A · 1 parcela · 0 selecionada',
    '1:1': 'Station A · 1 parcela · 1 selecionada',
    '2:1': 'Station A · 2 parcelas · 1 selecionada',
    '2:2': 'Station A · 2 parcelas · 2 selecionadas',
  },
};

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

  it('owns the complete Phase 4 where, group, plot, batch, and timeline key tree', () => {
    const phase4Keys = keyShape(en)
      .filter((key) => key.startsWith('where.')
        || key.startsWith('group.')
        || key.startsWith('plot.')
        || key.startsWith('batch.')
        || key.startsWith('timeline.batch'))
      .sort();

    expect(phase4Keys).toEqual([...REQUIRED_PHASE4_KEYS].sort());
  });

  it('exposes every required Phase 4 component key at its exact English path', () => {
    for (const key of REQUIRED_PHASE4_KEYS) {
      expect(valueAtPath(en, key), key).toEqual(expect.any(String));
    }
  });

  it('exposes every source-derived and dynamic-map consumer key as an English string', () => {
    const literalConsumerKeys = sourceConsumerKeys();
    expect(literalConsumerKeys.length).toBeGreaterThan(0);
    expect(literalConsumerKeys).toEqual(expect.arrayContaining([
      'title',
      'error.body',
      'error.retry',
      'error.title',
      'filters.activity',
      'filters.allActivities',
      'filters.allPlots',
      'filters.plot',
      'logActivity',
      'unavailable.body',
      'unavailable.title',
    ]));
    const consumerKeys = new Set([...literalConsumerKeys, ...DYNAMIC_MAP_KEYS]);
    for (const key of consumerKeys) {
      expect(valueAtPath(en, key), key).toEqual(expect.any(String));
    }
  });

  it.each([
    ['en', en],
    ['de-CH', deCH],
    ['es', es],
    ['fr', fr],
    ['it', itLocale],
    ['lg', lg],
    ['pt', pt],
  ])('%s resolves group members and count-bearing journal keys through i18next', async (locale, resource) => {
    const pluralKeys = [
      'where.selectionCount',
      'batch.count',
      'batch.confirmCount',
      'where.rangePlotCount',
      'where.rangeSelectedCount',
    ] as const;
    const i18n = i18next.createInstance();
    try {
      await i18n.init({
        lng: locale,
        ns: ['journal'],
        defaultNS: 'journal',
        resources: { [locale]: { journal: resource } },
      });
      const t = i18n.getFixedT(locale, 'journal');
      const countCases = (key: typeof pluralKeys[number] | 'group.members') => {
        expect(t(key)).toBe(valueAtPath(resource, key));
        expect(t(key, { count: 1 })).toBe(
          String(valueAtPath(resource, `${key}_one`)).replace('{{count}}', '1'),
        );
        expect(t(key, { count: 2 })).toBe(
          String(valueAtPath(resource, `${key}_other`)).replace('{{count}}', '2'),
        );
      };

      countCases('group.members');
      for (const key of pluralKeys) countCases(key);
    } finally {
      cleanupJournalI18n(i18n, locale);
    }
  });

  it.each([
    ['en', en],
    ['de-CH', deCH],
    ['es', es],
    ['fr', fr],
    ['it', itLocale],
    ['lg', lg],
    ['pt', pt],
  ])('%s renders station range summaries for all count combinations', async (locale, resource) => {
    const expected = STATION_RANGE_EXPECTED[locale];
    const i18n = i18next.createInstance();
    try {
      await i18n.init({
        lng: locale,
        ns: ['journal'],
        defaultNS: 'journal',
        resources: { [locale]: { journal: resource } },
      });
      const t = i18n.getFixedT(locale, 'journal');
      for (const [plotCount, selectedCount] of [[1, 0], [1, 1], [2, 1], [2, 2]]) {
        const plotCountLabel = t('where.rangePlotCount', { count: plotCount });
        const selectedCountLabel = t('where.rangeSelectedCount', { count: selectedCount });
        expect(t('where.rangeSummary', {
          label: 'Station A',
          plotCount: plotCountLabel,
          selectedCount: selectedCountLabel,
        })).toBe(expected[`${plotCount}:${selectedCount}`]);
      }
    } finally {
      cleanupJournalI18n(i18n, locale);
    }
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

  it('preserves the focused Phase 4 interpolation token sets', () => {
    const resources = { en, 'de-CH': deCH, es, fr, it: itLocale, lg, pt };

    for (const [locale, resource] of Object.entries(resources)) {
      for (const [key, tokens] of Object.entries(PHASE4_INTERPOLATION_TOKENS)) {
        expect(interpolationTokens(valueAtPath(resource, key)), `${locale}:${key}`)
          .toEqual([...tokens].sort());
      }
    }
  });
});
