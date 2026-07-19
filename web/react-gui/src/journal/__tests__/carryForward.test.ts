import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listEntries } = vi.hoisted(() => ({ listEntries: vi.fn() }));

vi.mock('../../services/journalApi', () => ({
  journalApi: { listEntries },
}));

import {
  loadCarryForwardCandidate,
  partitionCarryForward,
  PLANT_PROTECTION_PROTECTED_CODES,
} from '../carryForward';
import type {
  EntryAggregate,
  EntryValue,
  JournalDefinitionRow,
} from '../../types/journal';
// @ts-expect-error The authoritative catalog source is a CommonJS generator input.
import coreCatalog from '../../../../../scripts/journal-catalog-core.js';
// @ts-expect-error The authoritative generator is CommonJS and has no TypeScript declaration.
import catalogGenerator from '../../../../../scripts/generate-journal-catalog.js';
import agroscopeSource from '../../../../../docs/superpowers/specs/agroscope-open-field/catalog.json';

const draftUuid = 'draft-uuid';
const timestamp = '2026-07-16T00:00:00.000Z';

function value(
  attribute_code: string,
  value_text: string,
  overrides: Partial<EntryValue> = {},
): EntryValue {
  return {
    group_index: 0,
    attribute_code,
    value_status: 'observed',
    value_num: null,
    value_text,
    unit_code: null,
    entered_value_num: null,
    entered_unit_code: null,
    ...overrides,
  };
}

function entry(overrides: Partial<EntryAggregate> = {}): EntryAggregate {
  return {
    contract_version: 1,
    entry_uuid: 'source-uuid',
    owner_user_uuid: 'owner',
    author_principal_uuid: 'author',
    author_label: null,
    gateway_device_eui: 'gateway',
    plot_uuid: 'plot-1',
    zone_uuid: null,
    device_eui: null,
    season_uuid: 'season-1',
    season_crop: 'Wheat',
    season_variety: null,
    campaign_uuid: null,
    protocol_code: null,
    protocol_version: null,
    observation_unit_code: null,
    activity_code: 'plant_protection_application',
    template_code: 'full_record',
    template_version: 1,
    layout_code: 'open_field',
    layout_version: 1,
    catalog_version: 1,
    occurred_start: '2026-07-15T08:00:00.000Z',
    occurred_end: null,
    occurred_timezone: 'Europe/Zurich',
    occurred_utc_offset_minutes: 120,
    origin: 'edge-ui',
    status: 'final',
    batch_uuid: null,
    pass_uuid: null,
    voided_at: null,
    voided_by_principal_uuid: null,
    void_reason: null,
    note: null,
    context_json: null,
    sync_version: 1,
    recorded_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: null,
    values: [],
    ...overrides,
  };
}

const draft = entry({
  entry_uuid: draftUuid,
  status: 'draft',
  occurred_start: '2026-07-16T08:00:00.000Z',
  values: [value('attr.operator', 'Alex')],
});

function setPages(...pages: Array<{ entries: unknown[]; next_cursor: string | null }>) {
  listEntries.mockImplementation(async (filters: unknown) => {
    const request = (filters ?? {}) as { status?: string; cursor?: string };
    if (request.status === 'all') return { entries: [draft], next_cursor: null };
    const cursor = request.cursor;
    return pages[cursor === 'opaque-page-1' ? 1 : 0];
  });
}

describe('carry-forward loading', () => {
  beforeEach(() => listEntries.mockReset());

  const malformedRows: Array<[string, (base: EntryAggregate) => unknown]> = [
    ['null row', () => null],
    ['empty UUID', (base) => ({ ...base, entry_uuid: '' })],
    ['non-string UUID', (base) => ({ ...base, entry_uuid: 42 })],
    ['empty plot', (base) => ({ ...base, plot_uuid: '' })],
    ['non-string plot', (base) => ({ ...base, plot_uuid: 42 })],
    ['empty season', (base) => ({ ...base, season_uuid: '' })],
    ['non-string season', (base) => ({ ...base, season_uuid: 42 })],
    ['non-string crop', (base) => ({ ...base, season_crop: 42 })],
    ['invalid status', (base) => ({ ...base, status: 'unknown' })],
    ['non-string activity', (base) => ({ ...base, activity_code: 42 })],
    ['date-only occurrence', (base) => ({ ...base, occurred_start: '2026-07-15' })],
    ['invalid occurrence', (base) => ({ ...base, occurred_start: 'not-an-instant' })],
    ['non-string layout', (base) => ({ ...base, layout_code: 42 })],
    ['non-integer layout version', (base) => ({ ...base, layout_version: 1.5 })],
    ['non-array values', (base) => ({ ...base, values: null })],
  ];

  const consumedValueFields: Array<keyof EntryValue> = [
    'group_index',
    'attribute_code',
    'value_status',
    'value_num',
    'value_text',
    'unit_code',
    'entered_value_num',
    'entered_unit_code',
  ];
  const malformedValues: Array<[string, (base: EntryValue) => unknown]> = [
    ['boxed value status', (base) => ({ ...base, value_status: new String('observed') })],
    ['negative group index', (base) => ({ ...base, group_index: -1 })],
    ['non-string attribute code', (base) => ({ ...base, attribute_code: 42 })],
    ['non-number canonical value', (base) => ({ ...base, value_num: '2' })],
    ['non-string text value', (base) => ({ ...base, value_text: 2 })],
    ['non-string canonical unit', (base) => ({ ...base, unit_code: 42 })],
    ['non-number entered value', (base) => ({ ...base, entered_value_num: '2' })],
    ['non-string entered unit', (base) => ({ ...base, entered_unit_code: 42 })],
    ...consumedValueFields.map((field): [string, (base: EntryValue) => unknown] => [
      `omitted ${field}`,
      (base) => {
        const row: Partial<EntryValue> = { ...base };
        delete row[field];
        return row;
      },
    ]),
  ];

  it.each(malformedRows)('fails closed for a malformed draft %s', async (_case, makeRow) => {
    const malformedDraft = makeRow(draft);
    listEntries.mockResolvedValue({ entries: [malformedDraft], next_cursor: null });

    await expect(loadCarryForwardCandidate(draftUuid)).resolves.toBeNull();
    expect(listEntries).toHaveBeenCalledTimes(1);
  });

  it.each(malformedRows)('fails closed for a malformed source %s', async (_case, makeRow) => {
    const row = makeRow(entry());
    listEntries.mockImplementation(async (filters: { status?: string } | undefined) =>
      filters?.status === 'all'
        ? { entries: [draft], next_cursor: null }
        : { entries: [row, entry({ entry_uuid: 'valid-source' })], next_cursor: null });

    await expect(loadCarryForwardCandidate(draftUuid)).resolves.toBeNull();
  });

  it.each(malformedValues)(
    'fails closed for a source with malformed nested value %s',
    async (_case, makeValue) => {
      const malformedValue = makeValue(value('attr.operator', 'Alex'));
      const malformedSource = {
        ...entry({ entry_uuid: 'malformed-source' }),
        values: [malformedValue],
      };
      listEntries.mockImplementation(async (filters: { status?: string } | undefined) =>
        filters?.status === 'all'
          ? { entries: [draft], next_cursor: null }
          : {
              entries: [malformedSource, entry({ entry_uuid: 'valid-source' })],
              next_cursor: null,
            });

      await expect(loadCarryForwardCandidate(draftUuid)).resolves.toBeNull();
    },
  );

  it.each([
    ['season', { season_uuid: null }],
    ['plot', { plot_uuid: null }],
  ])('rejects a draft with a null %s before loading sources', async (_fence, changes) => {
    listEntries.mockResolvedValue({
      entries: [{ ...draft, ...changes }],
      next_cursor: null,
    });

    await expect(loadCarryForwardCandidate(draftUuid)).resolves.toBeNull();
    expect(listEntries).toHaveBeenCalledTimes(1);
  });

  it('loads the exact draft first, then follows opaque final-entry cursors', async () => {
    const source = entry({ values: [value('attr.operator', 'Taylor')] });
    setPages(
      { entries: [entry({ activity_code: 'irrigation' })], next_cursor: 'opaque-page-1' },
      { entries: [source], next_cursor: null },
    );

    const result = await loadCarryForwardCandidate(draftUuid);

    expect(result?.source.entry_uuid).toBe(source.entry_uuid);
    expect(listEntries).toHaveBeenNthCalledWith(1, {
      entry_uuid: draftUuid,
      status: 'all',
      limit: 100,
    });
    expect(listEntries).toHaveBeenNthCalledWith(2, { status: 'final', limit: 100 });
    expect(listEntries).toHaveBeenNthCalledWith(3, {
      status: 'final',
      limit: 100,
      cursor: 'opaque-page-1',
    });
  });

  it('chooses the newest compatible source from an unordered page', async () => {
    const older = entry({
      entry_uuid: 'source-older',
      occurred_start: '2026-07-14T08:00:00.000Z',
    });
    const newer = entry({
      entry_uuid: 'source-newer',
      occurred_start: '2026-07-15T08:00:00.000Z',
    });
    setPages({ entries: [older, newer], next_cursor: null });

    await expect(loadCarryForwardCandidate(draftUuid)).resolves.toMatchObject({
      source: { entry_uuid: 'source-newer' },
    });
  });

  it('scans every opaque-cursor page before choosing the newest compatible source', async () => {
    const older = entry({
      entry_uuid: 'source-older',
      occurred_start: '2026-07-14T08:00:00.000Z',
    });
    const newer = entry({
      entry_uuid: 'source-newer',
      occurred_start: '2026-07-15T08:00:00.000Z',
    });
    setPages(
      { entries: [older], next_cursor: 'opaque-page-1' },
      { entries: [newer], next_cursor: null },
    );

    await expect(loadCarryForwardCandidate(draftUuid)).resolves.toMatchObject({
      source: { entry_uuid: 'source-newer' },
    });
    expect(listEntries).toHaveBeenCalledTimes(3);
  });

  it('uses ascending code-unit entry UUID as a stable tie-breaker', async () => {
    const occurred_start = '2026-07-15T08:00:00.000Z';
    setPages({ entries: [
      entry({ entry_uuid: 'source-a', occurred_start }),
      entry({ entry_uuid: 'source-Z', occurred_start }),
    ], next_cursor: null });

    await expect(loadCarryForwardCandidate(draftUuid)).resolves.toMatchObject({
      source: { entry_uuid: 'source-Z' },
    });
  });

  it('rejects an exact-draft lookup that unexpectedly has another page', async () => {
    listEntries.mockResolvedValue({ entries: [draft], next_cursor: 'unexpected-draft-page' });

    await expect(loadCarryForwardCandidate(draftUuid)).resolves.toBeNull();
    expect(listEntries).toHaveBeenCalledTimes(1);
  });

  it('fails closed when opaque final-entry cursors form a cycle', async () => {
    listEntries.mockImplementation(async (filters?: { status?: string; cursor?: string }) => {
      if (filters?.status === 'all') return { entries: [draft], next_cursor: null };
      const next_cursor = filters?.cursor === 'cursor-a'
        ? 'cursor-b'
        : filters?.cursor === 'cursor-b' ? 'cursor-a' : 'cursor-a';
      return { entries: [], next_cursor };
    });

    await expect(loadCarryForwardCandidate(draftUuid)).resolves.toBeNull();
    expect(listEntries).toHaveBeenCalledTimes(4);
  });

  it('fails closed after a finite 100-page final-entry budget', async () => {
    let finalPages = 0;
    listEntries.mockImplementation(async (filters?: { status?: string }) => {
      if (filters?.status === 'all') return { entries: [draft], next_cursor: null };
      if (filters?.status !== 'final') return { entries: [], next_cursor: null };
      finalPages += 1;
      if (finalPages > 100) throw new Error('unbounded pagination');
      return { entries: [], next_cursor: `cursor-${finalPages}` };
    });

    await expect(loadCarryForwardCandidate(draftUuid)).resolves.toBeNull();
    expect(finalPages).toBe(100);
    expect(listEntries).toHaveBeenCalledTimes(101);
  });

  it.each([
    ['missing exact draft', []],
    ['final row is not authoritative', [entry({ entry_uuid: draftUuid, status: 'final' })]],
    ['duplicate exact drafts', [draft, draft]],
    ['same UUID appears with draft and final statuses', [
      draft,
      entry({ entry_uuid: draftUuid, status: 'final' }),
    ]],
  ])('returns no candidate for %s', async (_case, entries) => {
    listEntries.mockResolvedValue({ entries, next_cursor: null });

    await expect(loadCarryForwardCandidate(draftUuid)).resolves.toBeNull();
    expect(listEntries).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['season', { season_uuid: 'other-season' }],
    ['plot', { plot_uuid: 'other-plot' }],
    ['activity', { activity_code: 'irrigation' }],
    ['layout code', { layout_code: 'protected_culture' }],
    ['layout version', { layout_version: 2 }],
    ['source occurrence after draft', { occurred_start: '2026-07-16T09:00:00.000Z' }],
    ['null source season', { season_uuid: null }],
    ['null source plot', { plot_uuid: null }],
  ])('rejects a source with a mismatched %s fence', async (_fence, changes) => {
    setPages({ entries: [entry(changes)], next_cursor: null });

    await expect(loadCarryForwardCandidate(draftUuid)).resolves.toBeNull();
  });

  it('does not let malformed context JSON break stored-row fence resolution', async () => {
    const source = entry({ context_json: '{not-json' });
    listEntries.mockImplementation(async (filters: { status?: string } | undefined) =>
      filters?.status === 'all'
        ? { entries: [entry({ entry_uuid: draftUuid, status: 'draft', context_json: '{also-not-json' })], next_cursor: null }
        : { entries: [source], next_cursor: null });

    await expect(loadCarryForwardCandidate(draftUuid)).resolves.toMatchObject({
      source: { entry_uuid: source.entry_uuid },
    });
  });
});

describe('carry-forward partitioning', () => {
  const labels = {
    productLabels: new Map([
      ['product-1', 'Catalog Product'],
      ['product-2', 'Second Product'],
    ]),
    unitLabels: new Map([['unit.kg_per_ha_product', 'kg/ha']]),
  };

  it('silently copies only declared low-risk values and keeps protected values for explicit repeat', () => {
    const protectedCodes = [
      'attr.product_uuid',
      'attr.product',
      'attr.target',
      'attr.amount_mass_area_product',
      'attr.amount_volume_area_product',
      'attr.amount_biological_count_area',
      'attr.treated_area',
      'attr.waiting_period_days',
      'attr.denominator',
    ];
    const source = entry({ values: [
      value('attr.operator', 'Alex'),
      value('attr.equipment', 'Sprayer'),
      value('attr.method', 'Broadcast'),
      value('attr.product_uuid', 'product-1'),
      value('attr.product', 'Product A'),
      value('attr.target', 'Aphids'),
      value('attr.amount_mass_area_product', '2'),
      value('attr.amount_volume_area_product', '2'),
      value('attr.amount_biological_count_area', '2'),
      value('attr.treated_area', '1.5'),
      value('attr.waiting_period_days', '14'),
      value('attr.denominator', 'choice.denominator.area'),
    ] });
    const template = {
      code: 'full_record',
      version: 1,
      active: 1,
      catalog_errors: [],
      definition: {
        carry_forward: ['attr.operator', 'attr.equipment', 'attr.method', ...protectedCodes],
      },
    } satisfies JournalDefinitionRow;

    const result = partitionCarryForward(source, template);

    expect(result.automaticValues.map(({ attribute_code }) => attribute_code)).toEqual([
      'attr.operator', 'attr.equipment', 'attr.method',
    ]);
    for (const protectedCode of protectedCodes) {
      expect(result.automaticValues.map(({ attribute_code }) => attribute_code))
        .not.toContain(protectedCode);
    }
    expect(result.repeatTreatment?.values.map(({ attribute_code }) => attribute_code))
      .toEqual(protectedCodes);
    expect(result.repeatTreatment).toMatchObject({
      sourceDate: source.occurred_start,
      crop: source.season_crop,
    });
  });

  it('derives protection expectations from the compiled plant-protection contract', () => {
    const compiled = (catalogGenerator as {
      compileCatalog: (core: unknown, source: unknown) => { rows: Array<{ table: string; columns: string[]; values: unknown[] }> };
    }).compileCatalog(coreCatalog, agroscopeSource);
    const rowObject = (row: { columns: string[]; values: unknown[] }) =>
      Object.fromEntries(row.columns.map((column, index) => [column, row.values[index]]));
    const definition = (table: string, code: string) => {
      const row = compiled.rows.find((candidate) => {
        if (candidate.table !== table) return false;
        const object = rowObject(candidate);
        return object.code === code && object.version === 1;
      });
      if (!row) throw new Error(`missing compiled ${table} ${code}`);
      return JSON.parse(String(rowObject(row).definition_json)) as Record<string, unknown>;
    };
    const fullRecord = definition('journal_templates', 'full_record');
    const openField = definition('journal_layouts', 'open_field');
    const protection = (fullRecord.activity_requirements as Record<string, Record<string, unknown>>)
      .plant_protection_application;
    const attributeRows = compiled.rows
      .filter((row) => row.table === 'journal_vocab' && rowObject(row).kind === 'attribute')
      .map(rowObject);
    const denominatorCode = (openField.minimum_fields as string[]).find((code) =>
      attributeRows.some((row) => row.code === code &&
        String((JSON.parse(String(row.labels_json)) as Record<string, string>).en)
          .toLowerCase().includes('denominator')));
    const expectedFromCatalog = new Set([
      ...(protection.required as string[]),
      ...(protection.required_any as string[][]).flat(),
      ...(denominatorCode ? [denominatorCode] : []),
      'attr.target',
      'attr.waiting_period_days',
    ].filter((code) => code.startsWith('attr.')));
    const catalogAttributeCodes = new Set(
      compiled.rows
        .filter((row) => row.table === 'journal_vocab' && rowObject(row).kind === 'attribute')
        .map((row) => String(rowObject(row).code)),
    );

    expect(new Set(PLANT_PROTECTION_PROTECTED_CODES)).toEqual(expectedFromCatalog);
    expect([...expectedFromCatalog].every((code) => catalogAttributeCodes.has(code))).toBe(true);
  });

  it('does not expose a repeat-treatment action for other activities', () => {
    const source = entry({ activity_code: 'irrigation', values: [value('attr.operator', 'Alex')] });
    const template = {
      definition: { carry_forward: ['attr.operator'] },
    } satisfies Pick<JournalDefinitionRow, 'definition'>;

    expect(partitionCarryForward(source, template).repeatTreatment).toBeNull();
  });

  it('does not block low-risk lookalike codes through substring matching', () => {
    const lookalikeCodes = [
      'attr.productivity_note',
      'attr.targeting_method',
      'attr.rate_control_note',
      'attr.amount_operation_depth',
      'attr.amount_duration_area',
    ];
    const source = entry({
      activity_code: 'irrigation',
      values: lookalikeCodes.map((code) => value(code, 'safe')),
    });

    const result = partitionCarryForward(source, { carry_forward: lookalikeCodes });

    expect(result.automaticValues.map(({ attribute_code }) => attribute_code))
      .toEqual(lookalikeCodes);
  });

  it('resolves a deterministic product label and human entered-rate unit', () => {
    const source = entry({ values: [
      value('attr.product', 'Free-text fallback'),
      value('attr.product_uuid', 'product-1'),
      value('attr.amount_mass_area_product', '2000', {
        value_text: null,
        value_num: 2000,
        unit_code: 'unit.g_per_ha_product',
        entered_value_num: 2,
        entered_unit_code: 'unit.kg_per_ha_product',
      }),
    ] });

    const result = partitionCarryForward(
      source,
      { carry_forward: [] },
      labels,
    );

    expect(result.repeatTreatment).toMatchObject({
      complete: true,
      product: 'Catalog Product',
      rate: '2 kg/ha',
    });
    expect(result.repeatTreatment?.product).not.toContain('product-1');
    expect(result.repeatTreatment?.rate).not.toContain('unit.');
  });

  it.each([
    ['unknown product UUID', [
      value('attr.product_uuid', 'unknown-product'),
      value('attr.amount_mass_area_product', '2', {
        value_text: null,
        value_num: 2,
        unit_code: 'unit.kg_per_ha_product',
      }),
    ], labels],
    ['missing rate', [value('attr.product_uuid', 'product-1')], labels],
    ['unknown unit label', [
      value('attr.product_uuid', 'product-1'),
      value('attr.dose', '2', {
        value_text: null,
        value_num: 2,
        unit_code: 'unit.unknown',
      }),
    ], labels],
  ])('returns a non-confirmable offer for %s', (_case, values, labelSources) => {
    const result = partitionCarryForward(
      entry({ values }),
      { carry_forward: [] },
      labelSources,
    );

    expect(result.repeatTreatment).toMatchObject({
      complete: false,
      product: null,
      rate: null,
    });
  });

  it('does not make a multi-group treatment confirmable when a later group lacks product or rate', () => {
    const source = entry({ values: [
      value('attr.product_uuid', 'product-1', { group_index: 0 }),
      value('attr.amount_mass_area_product', '2', {
        group_index: 0,
        value_text: null,
        value_num: 2,
        unit_code: 'unit.kg_per_ha_product',
        entered_value_num: 2,
        entered_unit_code: 'unit.kg_per_ha_product',
      }),
      value('attr.product_uuid', 'product-2', { group_index: 1 }),
    ] });

    const result = partitionCarryForward(source, { carry_forward: [] }, labels);

    expect(result.repeatTreatment).toMatchObject({
      complete: false,
      product: null,
      rate: null,
    });
    expect(result.repeatTreatment?.groupedTreatments).toEqual([
      { groupIndex: 0, product: 'Catalog Product', rate: '2 kg/ha' },
      { groupIndex: 1, product: 'Second Product', rate: null },
    ]);
  });
});
