import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';

import {
  activeDefinition,
  allowedChoices,
  allowedUnits,
  buildCatalogModel,
  catalogLabel,
  convertNumericValue,
  deriveActivityLeaves,
  isLayoutTemplateCompatible,
} from '../catalogModel';
import { deriveFieldStates } from '../templateEngine';
import { validateEntryForm } from '../../components/journal/capture/EntryForm';
import type {
  JournalCatalog,
  JournalDefinitionRow,
  JournalVocabRow,
} from '../../types/journal';
// @ts-expect-error The authoritative catalog source is a CommonJS generator input.
import coreCatalog from '../../../../../scripts/journal-catalog-core.js';
// @ts-expect-error The authoritative generator is CommonJS and has no TypeScript declaration.
import catalogGenerator from '../../../../../scripts/generate-journal-catalog.js';
import agroscopeSource from '../../../../../docs/superpowers/specs/agroscope-open-field/catalog.json';

const timestamp = '2026-07-15T00:00:00.000Z';

interface CompiledCatalogRow {
  table: string;
  columns: string[];
  values: unknown[];
}

function vocab(
  code: string,
  kind: JournalVocabRow['kind'],
  overrides: Partial<JournalVocabRow> = {},
): JournalVocabRow {
  return {
    code,
    kind,
    parent_code: null,
    value_type: null,
    quantity_kind: null,
    basis: null,
    default_unit_code: null,
    icon_key: null,
    scope: 'core',
    owner_user_uuid: null,
    gateway_device_eui: null,
    custom_field_uuid: null,
    active: 1,
    sort_order: 0,
    sync_version: 0,
    created_at: timestamp,
    deleted_at: null,
    catalog_errors: [],
    labels: { en: code },
    constraints: null,
    ...overrides,
  };
}

function definition(
  code: string,
  body: Record<string, unknown>,
  overrides: Partial<JournalDefinitionRow> = {},
): JournalDefinitionRow {
  return {
    code,
    version: 1,
    active: 1,
    catalog_errors: [],
    labels: { en: code },
    definition: body,
    ...overrides,
  };
}

const activityCodes = ['irrigation', 'fertilization'];
const templates = [
  definition('farmer_quick', {
    sections: [
      { code: 'identity', fields: ['activity_code', 'plot_uuid', 'occurred_start'] },
      { code: 'values', fields: ['attr.amount', 'note', 'attr.custom.note'] },
    ],
    max_primary_fields: 5,
    carry_forward: ['attr.custom.note'],
  }),
  definition('full_record', {
    fields: ['activity_code', 'attr.operation', 'attr.device', 'attr.amount'],
  }),
  definition('research_observation', {
    sections: [
      { code: 'identity', fields: ['activity_code'] },
      { code: 'custom', include_scope: 'custom' },
    ],
    require_explicit_choices: true,
    show_standard_mappings: true,
  }),
];
const layouts = [
  definition('open_field', {
    activity_codes: activityCodes,
    supported_templates: ['farmer_quick', 'full_record', 'research_observation'],
    minimum_fields: ['attr.denominator'],
    denominator_contract: ['area', 'plant', 'row'],
    option_dependencies: [],
  }),
  definition('greenhouse', {
    activity_codes: activityCodes,
    supported_templates: ['farmer_quick', 'full_record', 'research_observation'],
    minimum_fields: ['attr.denominator'],
    conditional_fields: { solution_managed: ['attr.amount'] },
    option_dependencies: [],
  }),
  definition('lysimeter', {
    activity_codes: activityCodes,
    supported_templates: ['farmer_quick', 'full_record', 'research_observation'],
    minimum_fields: ['attr.amount'],
    option_dependencies: [],
  }),
  definition('agroscope_open_field', {
    activity_codes: ['fertilization'],
    supported_templates: ['research_observation'],
    fields: ['attr.operation', 'attr.device', 'attr.amount'],
    option_dependencies: [
      {
        when: { attribute_code: 'activity_code', equals: 'fertilization' },
        restrict: {
          attribute_code: 'attr.operation',
          choices: ['operation.spreading'],
        },
      },
      {
        when: { attribute_code: 'attr.operation', equals: 'operation.spreading' },
        restrict: {
          attribute_code: 'attr.device',
          choices: ['device.broadcast'],
        },
      },
      {
        when: { attribute_code: 'attr.device', equals: 'device.broadcast' },
        restrict: { attribute_code: 'attr.amount', units: ['unit.kg_per_ha'] },
      },
    ],
  }),
];

function catalog(): JournalCatalog {
  return {
    catalog_version: 1,
    catalog_hash: 'fixture',
    vocab: [
      ...activityCodes.map((code, index) =>
        vocab(code, 'activity', { sort_order: index, labels: { en: code, 'de-CH': `${code}-de` } }),
      ),
      vocab('attr.operation', 'attribute', { value_type: 'choice' }),
      vocab('attr.device', 'attribute', { value_type: 'choice' }),
      vocab('attr.denominator', 'attribute', { value_type: 'choice' }),
      vocab('attr.amount', 'attribute', {
        value_type: 'number',
        quantity_kind: 'mass_area',
        basis: 'product_mass_per_area',
        default_unit_code: 'unit.kg_per_ha',
        constraints: { min: 0 },
      }),
      vocab('attr.custom.note', 'attribute', {
        value_type: 'text',
        scope: 'custom',
        sort_order: 10,
      }),
      vocab('attr.flag', 'attribute', { value_type: 'boolean' }),
      vocab('attr.date', 'attribute', { value_type: 'date' }),
      vocab('operation.spreading', 'choice', { parent_code: 'attr.operation' }),
      vocab('operation.other', 'choice', { parent_code: 'attr.operation' }),
      vocab('device.broadcast', 'choice', { parent_code: 'attr.device' }),
      vocab('device.other', 'choice', { parent_code: 'attr.device' }),
      vocab('unit.kg_per_ha', 'unit', {
        quantity_kind: 'mass_area',
        basis: 'product_mass_per_area',
        constraints: {
          dimension: 'product_mass_per_area',
          to_canonical: { unit_code: 'unit.kg_per_ha', scale: 1, offset: 0 },
        },
      }),
      vocab('unit.g_per_m2', 'unit', {
        quantity_kind: 'mass_area',
        basis: 'product_mass_per_area',
        constraints: {
          dimension: 'product_mass_per_area',
          to_canonical: { unit_code: 'unit.kg_per_ha', scale: 10, offset: 0 },
        },
      }),
      vocab('unit.kg_per_ha_inactive', 'unit', {
        active: 0,
        quantity_kind: 'mass_area',
        basis: 'product_mass_per_area',
        constraints: {
          dimension: 'product_mass_per_area',
          to_canonical: { unit_code: 'unit.kg_per_ha', scale: 1, offset: 0 },
        },
      }),
      vocab('unit.kg_n_per_ha', 'unit', {
        quantity_kind: 'mass_area',
        basis: 'nutrient_mass_per_area',
        constraints: {
          dimension: 'nutrient_mass_per_area',
          to_canonical: { unit_code: 'unit.kg_n_per_ha', scale: 1, offset: 0 },
        },
      }),
    ],
    templates: structuredClone(templates),
    layouts: structuredClone(layouts),
    products: [],
    mappings: [],
  };
}

function compiledRowObject(row: CompiledCatalogRow): Record<string, unknown> {
  return Object.fromEntries(row.columns.map((column, index) => [column, row.values[index]]));
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null;
  return JSON.parse(value) as Record<string, unknown>;
}

function shippedCatalog(): JournalCatalog {
  const compiled = (catalogGenerator as {
    compileCatalog: (
      core: unknown,
      source: unknown,
    ) => { rows: CompiledCatalogRow[] };
  }).compileCatalog(coreCatalog, agroscopeSource);
  const vocabRows = compiled.rows
    .filter(({ table }) => table === 'journal_vocab')
    .map((row) => {
      const value = compiledRowObject(row);
      return vocab(String(value.code), value.kind as JournalVocabRow['kind'], {
        parent_code: value.parent_code == null ? null : String(value.parent_code),
        value_type: value.value_type as JournalVocabRow['value_type'],
        quantity_kind: value.quantity_kind == null ? null : String(value.quantity_kind),
        basis: value.basis == null ? null : String(value.basis),
        default_unit_code: value.default_unit_code == null ? null : String(value.default_unit_code),
        labels: parseJsonObject(value.labels_json) as Record<string, string>,
        icon_key: value.icon_key == null ? null : String(value.icon_key),
        constraints: parseJsonObject(value.constraints_json),
        scope: value.scope as JournalVocabRow['scope'],
        active: Number(value.active),
        sort_order: Number(value.sort_order),
        sync_version: Number(value.sync_version),
        created_at: String(value.created_at),
      });
    });
  const definitions = (table: 'journal_templates' | 'journal_layouts') => compiled.rows
    .filter((row) => row.table === table)
    .map((row) => {
      const value = compiledRowObject(row);
      return definition(
        String(value.code),
        parseJsonObject(value.definition_json) ?? {},
        {
          version: Number(value.version),
          active: Number(value.active),
          labels: parseJsonObject(value.labels_json) as Record<string, string>,
        },
      );
    });
  return {
    catalog_version: 1,
    catalog_hash: 'authoritative-generator-fixture',
    vocab: vocabRows,
    templates: definitions('journal_templates'),
    layouts: definitions('journal_layouts'),
    products: [],
    mappings: [],
  };
}

describe('catalog model', () => {
  it('parses the authoritative shipped templates, layouts, and complete Agroscope cascade', () => {
    const fixture = shippedCatalog();
    const farmerDefinition = fixture.templates.find(({ code }) => code === 'farmer_quick')?.definition;
    const fullDefinition = fixture.templates.find(({ code }) => code === 'full_record')?.definition;
    const researchDefinition = fixture.templates.find(
      ({ code }) => code === 'research_observation',
    )?.definition;
    const agroscopeDefinition = fixture.layouts.find(
      ({ code }) => code === 'agroscope_open_field',
    )?.definition;
    expect(farmerDefinition).toMatchObject({
      max_primary_fields: 5,
      carry_forward: ['attr.operator', 'attr.equipment', 'attr.method'],
    });
    expect(fullDefinition).toMatchObject({
      activity_requirements: {
        fertilization: {
          required: ['attr.treated_area'],
          required_any: [
            ['attr.product_uuid', 'attr.product'],
            [
              'attr.amount_mass_area_product',
              'attr.amount_volume_area_product',
              'attr.amount_nutrient_rate',
            ],
          ],
        },
      },
      conditional_groups: [{
        code: 'irrigation_details',
        activity_codes: ['irrigation', 'fertigation'],
      }],
    });
    expect(researchDefinition).toMatchObject({
      require_explicit_choices: true,
      show_standard_mappings: true,
    });
    expect(agroscopeDefinition).toMatchObject({
      source: {
        name: 'SoilManageR management-data template',
        version: '2.6',
      },
    });
    expect(agroscopeDefinition?.treatment_factors).toMatchObject({
      plot_Parzelle: ['I', 'II', 'III', 'IV', 'V', 'VI', 'all'],
      tillage_system: ['Plough', 'No-till', 'all'],
    });

    const result = buildCatalogModel(fixture);
    expect(result.ok, result.ok ? '' : result.errors.join('; ')).toBe(true);
    if (!result.ok) return;
    const full = result.model.templates.get('full_record');
    const farmer = result.model.templates.get('farmer_quick');
    const layout = result.model.layouts.get('agroscope_open_field');
    expect(farmer?.carry_forward).toEqual(['attr.operator', 'attr.equipment', 'attr.method']);
    expect(full?.activity_requirements.fertilization.required_any).toHaveLength(2);
    expect(layout).toBeDefined();
    if (!layout) return;

    const unitRule = layout.option_dependencies.find((dependency) =>
      'units' in dependency.restrict && dependency.when.attribute_code === 'attr.agroscope.device');
    const deviceRule = unitRule && layout.option_dependencies.find((dependency) =>
      'choices' in dependency.restrict &&
      dependency.restrict.attribute_code === 'attr.agroscope.device' &&
      dependency.restrict.choices.includes(unitRule.when.equals));
    const operationRule = deviceRule && layout.option_dependencies.find((dependency) =>
      'choices' in dependency.restrict &&
      dependency.restrict.attribute_code === 'attr.agroscope.operation' &&
      dependency.restrict.choices.includes(deviceRule.when.equals));
    expect(unitRule).toBeDefined();
    expect(deviceRule).toBeDefined();
    expect(operationRule).toBeDefined();
    if (!unitRule || !deviceRule || !operationRule ||
        !('units' in unitRule.restrict) || !('choices' in deviceRule.restrict)) return;

    const activity = operationRule.when.equals;
    const operation = deviceRule.when.equals;
    const device = unitRule.when.equals;
    expect(allowedChoices(result.model, layout, 'attr.agroscope.operation', {
      activity_code: activity,
    })).toContain(operation);
    expect(allowedChoices(result.model, layout, 'attr.agroscope.device', {
      activity_code: activity,
      'attr.agroscope.operation': operation,
    })).toContain(device);
    const units = allowedUnits(result.model, layout, unitRule.restrict.attribute_code, {
      activity_code: activity,
      'attr.agroscope.operation': operation,
      'attr.agroscope.device': device,
    });
    expect(new Set(units)).toEqual(new Set(unitRule.restrict.units));
    expect(deriveActivityLeaves(result.model, layout)).toContainEqual({
      activity_code: activity,
      dependent_selections: [
        { attribute_code: 'attr.agroscope.operation', value: operation },
        { attribute_code: 'attr.agroscope.device', value: device },
      ],
    });
  });

  it('labels by locale fallback and picks the highest active definition', () => {
    expect(catalogLabel(catalog().vocab[0], 'de-CH')).toBe('irrigation-de');
    expect(catalogLabel({ ...catalog().vocab[0], labels: { en: 'Irrigation' } }, 'fr')).toBe(
      'Irrigation',
    );
    expect(catalogLabel({ ...catalog().vocab[0], labels: {} }, 'fr')).toBe('irrigation');

    const rows = [
      definition('full_record', {}, { version: 1 }),
      definition('full_record', {}, { version: 3, active: 0 }),
      definition('full_record', {}, { version: 2 }),
    ];
    expect(activeDefinition(rows, 'full_record')?.version).toBe(2);
  });

  it('parses all shipped definition shapes, expands custom scope, and fails closed', () => {
    const result = buildCatalogModel(catalog());
    expect(result.ok, result.ok ? '' : result.errors.join('; ')).toBe(true);
    if (!result.ok) return;

    expect([...result.model.templates.keys()]).toEqual([
      'farmer_quick',
      'full_record',
      'research_observation',
    ]);
    expect([...result.model.layouts.keys()]).toEqual([
      'open_field',
      'greenhouse',
      'lysimeter',
      'agroscope_open_field',
    ]);
    expect(result.model.templates.get('research_observation')?.sections[1].fields).toEqual([
      'attr.custom.note',
    ]);
    expect(result.model.templates.get('farmer_quick')?.carry_forward).toEqual([
      'attr.custom.note',
    ]);
    expect(result.model.templates.get('farmer_quick')?.max_primary_fields).toBe(5);
    expect(result.model.templates.get('research_observation')).toMatchObject({
      require_explicit_choices: true,
      show_standard_mappings: true,
    });
    expect(result.model.layouts.get('open_field')?.denominator_contract).toEqual([
      'area',
      'plant',
      'row',
    ]);

    const badDefinition = catalog();
    badDefinition.templates[0] = {
      ...badDefinition.templates[0],
      catalog_errors: ['definition_json'],
    };
    expect(buildCatalogModel(badDefinition).ok).toBe(false);

    const badArray = catalog();
    badArray.layouts[0] = definition('open_field', {
      activity_codes: 'irrigation',
      supported_templates: ['farmer_quick'],
      option_dependencies: [],
    });
    expect(buildCatalogModel(badArray).ok).toBe(false);
  });

  it('rejects a carry_forward code that is not in the template\'s own visible field set (Task 27 P4 guard)', () => {
    // This is exactly the shape of the historical farmer_quick@1 bug: a
    // carry_forward code that is never shown in any section, so nobody can
    // see or correct the value being silently carried into their entry.
    const invisibleCarryForward = catalog();
    invisibleCarryForward.templates[0] = definition('farmer_quick', {
      sections: [
        { code: 'identity', fields: ['activity_code', 'plot_uuid', 'occurred_start'] },
        { code: 'values', fields: ['attr.amount', 'note'] },
      ],
      max_primary_fields: 5,
      carry_forward: ['attr.flag'],
    });
    const result = buildCatalogModel(invisibleCarryForward);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join('; ')).toMatch(/farmer_quick/);

    // The same code, once actually shown in a visible section, must pass.
    const visibleCarryForward = catalog();
    visibleCarryForward.templates[0] = definition('farmer_quick', {
      sections: [
        { code: 'identity', fields: ['activity_code', 'plot_uuid', 'occurred_start'] },
        { code: 'values', fields: ['attr.amount', 'note', 'attr.flag'] },
      ],
      max_primary_fields: 5,
      carry_forward: ['attr.flag'],
    });
    expect(buildCatalogModel(visibleCarryForward).ok).toBe(true);

    // A carry_forward code covered only via a top-level (non-section) field
    // must also count as visible.
    const topLevelFieldCarryForward = catalog();
    topLevelFieldCarryForward.templates[0] = definition('farmer_quick', {
      fields: ['attr.flag'],
      sections: [
        { code: 'identity', fields: ['activity_code', 'plot_uuid', 'occurred_start'] },
      ],
      carry_forward: ['attr.flag'],
    });
    expect(buildCatalogModel(topLevelFieldCarryForward).ok).toBe(true);
  });

  it('accepts the shipped farmer_quick@2 carry_forward, since operator/equipment/method are visible there (P4 fix)', () => {
    const fixture = shippedCatalog();
    const result = buildCatalogModel(fixture);
    expect(result.ok, result.ok ? '' : result.errors.join('; ')).toBe(true);
    if (!result.ok) return;
    const farmer = result.model.templates.get('farmer_quick');
    expect(farmer?.version).toBe(2);
    expect(farmer?.carry_forward).toEqual(['attr.operator', 'attr.equipment', 'attr.method']);
    const visibleCodes = new Set(
      (farmer?.sections ?? []).flatMap((section) => section.fields).map((field) =>
        typeof field === 'string' ? field : String((field as { code?: unknown }).code)),
    );
    for (const code of farmer?.carry_forward ?? []) {
      expect(visibleCodes.has(code)).toBe(true);
    }
  });

  it('quick-entry capture pipeline: the P4 guard fails closed if v2 is missing; with the real v1+v2 catalog it visibly marks and submits all three', () => {
    const t = ((key: string) => key) as TFunction<'journal'>;
    const fullFixture = shippedCatalog();

    // If farmer_quick@2 were ever missing (the pre-Task-27 world), @1 would
    // become the active definition again — and the parseTemplate guard
    // (catalogModel.ts) now correctly fails the whole model closed rather
    // than silently shipping a quick-entry template that carries values
    // nobody can see. This is deliberately re-derived from the *real*
    // catalog content on every run, so it keeps proving the fix forever
    // instead of only at the moment this test was written.
    const v1OnlyFixture: JournalCatalog = {
      ...fullFixture,
      templates: fullFixture.templates.filter((row) =>
        !(row.code === 'farmer_quick' && row.version === 2)),
    };
    const v1OnlyResult = buildCatalogModel(v1OnlyFixture);
    expect(v1OnlyResult.ok).toBe(false);
    if (v1OnlyResult.ok) return;
    expect(v1OnlyResult.errors.join('; ')).toMatch(/farmer_quick/);

    // With the real, current catalog (v1 frozen + v2 active), the pipeline
    // must visibly mark operator/equipment/method as carried-forward fields
    // and include all three in the final submitted payload.
    const result = buildCatalogModel(fullFixture);
    expect(result.ok, result.ok ? '' : result.errors.join('; ')).toBe(true);
    if (!result.ok) return;
    const template = result.model.templates.get('farmer_quick');
    const layout = result.model.layouts.get('open_field');
    expect(template?.version).toBe(2);
    expect(layout).toBeDefined();
    if (!template || !layout) return;

    const selections = { activity_code: 'irrigation' };
    const fieldStates = deriveFieldStates(template, layout, selections);
    for (const code of ['attr.operator', 'attr.equipment', 'attr.method']) {
      const state = fieldStates.find((candidate) => candidate.code === code);
      expect(state?.visible, `${code} must be a visible field state`).toBe(true);
    }

    const carriedInputs = [
      { attribute_code: 'attr.operator', value_status: 'observed' as const, value_text: 'Alex' },
      { attribute_code: 'attr.equipment', value_status: 'observed' as const, value_text: 'Boom sprayer' },
      { attribute_code: 'attr.method', value_status: 'observed' as const, value_text: 'Drip line' },
    ];
    const validation = validateEntryForm({
      model: result.model,
      layout,
      fieldStates,
      inputs: carriedInputs,
      selections,
      numberInputErrors: new Map(),
      products: [],
      t,
    });
    expect(validation.payload).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute_code: 'attr.operator', value: 'Alex' }),
      expect.objectContaining({ attribute_code: 'attr.equipment', value: 'Boom sprayer' }),
      expect.objectContaining({ attribute_code: 'attr.method', value: 'Drip line' }),
    ]));
  });

  it('derives the Agroscope operation to device to unit cascade and deterministic leaves', () => {
    const result = buildCatalogModel(catalog());
    expect(result.ok, result.ok ? '' : result.errors.join('; ')).toBe(true);
    if (!result.ok) return;
    const layout = result.model.layouts.get('agroscope_open_field');
    expect(layout).toBeDefined();
    if (!layout) return;

    expect(allowedChoices(result.model, layout, 'attr.operation', { activity_code: 'fertilization' }))
      .toEqual(['operation.spreading']);
    expect(allowedChoices(result.model, layout, 'attr.device', {
      activity_code: 'fertilization',
      'attr.operation': 'operation.spreading',
    })).toEqual(['device.broadcast']);
    expect(allowedUnits(result.model, layout, 'attr.amount', {
      activity_code: 'fertilization',
      'attr.operation': 'operation.spreading',
      'attr.device': 'device.broadcast',
    })).toEqual(['unit.kg_per_ha']);

    expect(deriveActivityLeaves(result.model, layout)).toEqual([
      {
        activity_code: 'fertilization',
        dependent_selections: [
          { attribute_code: 'attr.operation', value: 'operation.spreading' },
          { attribute_code: 'attr.device', value: 'device.broadcast' },
        ],
      },
    ]);
  });

  it.each([
    [{ active: 0 }],
    [{ deleted_at: '2026-07-16T00:00:00.000Z' }],
  ])('omits inactive or deleted root activities from derived leaves: %j', (state) => {
    const fixture = catalog();
    const irrigation = fixture.vocab.find(({ code }) => code === 'irrigation');
    expect(irrigation).toBeDefined();
    if (!irrigation) return;
    Object.assign(irrigation, state);
    const result = buildCatalogModel(fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const layout = result.model.layouts.get('open_field');
    expect(layout).toBeDefined();
    if (!layout) return;

    expect(deriveActivityLeaves(result.model, layout).map(({ activity_code }) => activity_code))
      .toEqual(['fertilization']);
  });

  it('resolves all active compatible units, rejects cross-basis units, and converts exactly', () => {
    const result = buildCatalogModel(catalog());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const layout = result.model.layouts.get('open_field');
    expect(layout).toBeDefined();
    if (!layout) return;

    expect(allowedUnits(result.model, layout, 'attr.amount', {})).toEqual([
      'unit.g_per_m2',
      'unit.kg_per_ha',
    ]);
    expect(convertNumericValue(result.model, 'attr.amount', 2, 'unit.g_per_m2')).toEqual({
      value_num: 20,
      unit_code: 'unit.kg_per_ha',
      entered_value_num: 2,
      entered_unit_code: 'unit.g_per_m2',
    });
    expect(convertNumericValue(result.model, 'attr.amount', 2, 'unit.kg_n_per_ha')).toEqual({
      ok: false,
      code: 'cross_basis_forbidden',
    });
    expect(isLayoutTemplateCompatible(
      result.model.layouts.get('agroscope_open_field'),
      result.model.templates.get('farmer_quick'),
    )).toBe(false);
    expect(isLayoutTemplateCompatible(
      result.model.layouts.get('open_field'),
      result.model.templates.get('farmer_quick'),
    )).toBe(true);
  });

  it('fails the whole model when a dependency references an invalid choice', () => {
    const invalid = catalog();
    invalid.layouts[3] = definition('agroscope_open_field', {
      activity_codes: ['fertilization'],
      supported_templates: ['research_observation'],
      fields: ['attr.operation'],
      option_dependencies: [{
        when: { attribute_code: 'activity_code', equals: 'fertilization' },
        restrict: { attribute_code: 'attr.operation', choices: ['operation.missing'] },
      }],
    });
    expect(buildCatalogModel(invalid).ok).toBe(false);
  });

  it.each([
    [{ field: 'activity_code', op: 'eq', value: 'missing_activity' }],
    [{ field: 'template_code', op: 'eq', value: 'missing_template' }],
    [{ field: 'layout_code', op: 'in', value: ['missing_layout'] }],
    [{ field: 'attr.operation', op: 'eq', value: 'device.broadcast' }],
    [{ field: 'attr.flag', op: 'eq', value: 'true' }],
    [{ field: 'attr.custom.note', op: 'eq', value: false }],
    [{ field: 'attr.amount', op: 'eq', value: Number.POSITIVE_INFINITY }],
    [{ field: 'attr.date', op: 'eq', value: '2026-02-30' }],
    [{ field: 'attr.flag', op: 'in', value: [true, 'false'] }],
  ])('fails closed when a predicate value is outside its field domain: %j', (predicate) => {
    const invalid = catalog();
    invalid.templates[0] = definition('farmer_quick', {
      fields: [{ code: 'attr.custom.note', visible_if: predicate }],
    });

    expect(buildCatalogModel(invalid).ok).toBe(false);
  });

  it.each([
    [{ min: null }],
    [{ min: 2, max: 1 }],
    [{ step: 0 }],
    [{ requires_explicit_unit: 'yes' }],
    [{ allow_default_unit: 1 }],
    [{ semantic_discriminator: 'quantity_kind' }],
  ])('fails closed on malformed numeric constraints: %j', (constraints) => {
    const invalid = catalog();
    const amount = invalid.vocab.find(({ code }) => code === 'attr.amount');
    expect(amount).toBeDefined();
    if (!amount) return;
    amount.constraints = constraints;

    expect(buildCatalogModel(invalid).ok).toBe(false);
  });

  it.each([
    [
      'unit.empty_dimension',
      {
        dimension: '',
        to_canonical: {
          unit_code: 'unit.empty_dimension',
          scale: 1,
          offset: 0,
        },
      },
      [] as JournalVocabRow[],
    ],
    [
      'unit.empty_canonical',
      {
        dimension: 'explicit_dimension',
        to_canonical: { unit_code: '', scale: 1, offset: 0 },
      },
      [vocab('', 'unit', {
        quantity_kind: 'explicit_quantity',
        basis: 'explicit_basis',
        constraints: {
          dimension: 'explicit_dimension',
          to_canonical: { unit_code: '', scale: 1, offset: 0 },
        },
      })],
    ],
  ])('excludes %s when required unit conversion strings are empty', (
    unitCode,
    constraints,
    extraUnits,
  ) => {
    const fixture = catalog();
    fixture.vocab.push(
      vocab('attr.explicit_amount', 'attribute', {
        value_type: 'number',
        quantity_kind: 'explicit_quantity',
        basis: 'explicit_basis',
        default_unit_code: null,
        constraints: {
          requires_explicit_unit: true,
          allow_default_unit: false,
          semantic_discriminator: 'unit_code',
        },
      }),
      vocab(unitCode, 'unit', {
        quantity_kind: 'explicit_quantity',
        basis: 'explicit_basis',
        constraints,
      }),
      ...extraUnits,
    );
    const result = buildCatalogModel(fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const layout = result.model.layouts.get('open_field');
    expect(layout).toBeDefined();
    if (!layout) return;

    expect(allowedUnits(result.model, layout, 'attr.explicit_amount', {})).not.toContain(unitCode);
  });
});
