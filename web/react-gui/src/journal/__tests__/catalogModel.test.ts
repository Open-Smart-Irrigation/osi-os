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
  vocabLabelOrCode,
  withWeatherAtApplicationVisibility,
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

    // Slice F: the resolved (latest-version) farmer_quick is now v6 (BBCH
    // quick-optional fields, Slice F/F1) and must carry a quick_fields entry
    // for every one of the 16 core activities (unchanged completeness
    // guarantee since Slice BC introduced quick_fields at v3).
    expect(farmer?.version).toBe(6);
    expect(Object.keys(farmer?.quick_fields ?? {})).toHaveLength(16);
    expect(farmer?.quick_fields?.irrigation).toEqual(['attr.irrigation_depth', 'note']);
    expect(farmer?.quick_fields?.irrigation).not.toContain('attr.amount_mass_area_product');
    expect(farmer?.quick_fields?.fertilization).toEqual(expect.arrayContaining([
      'attr.product_uuid', 'attr.product', 'attr.amount_mass_area_product',
    ]));
    expect(farmer?.quick_fields?.fertilization).not.toContain('attr.irrigation_depth');
    for (const layoutCode of ['open_field', 'greenhouse', 'lysimeter']) {
      const resolved = result.model.layouts.get(layoutCode);
      expect(resolved?.version, `${layoutCode} resolves to its latest version`).toBe(3);
      expect((resolved?.static_context_fields ?? []).length, `${layoutCode} static_context_fields`)
        .toBeGreaterThan(0);
      for (const field of resolved?.reading_fields ?? []) {
        expect(resolved?.minimum_fields, `${layoutCode} minimum_fields must exclude reading field ${field}`)
          .not.toContain(field);
      }
    }
    expect(result.model.layouts.get('lysimeter')?.reading_fields).toEqual([
      'attr.interval_minutes', 'attr.water_input', 'attr.rain_input', 'attr.drainage_volume',
      'attr.mass_start', 'attr.mass_end', 'attr.tare_mass', 'attr.mass_method',
    ]);

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

  it('Slice BC: resolves activity-scoped Quick visibility against the real shipped catalog', () => {
    const fixture = shippedCatalog();
    const result = buildCatalogModel(fixture);
    expect(result.ok, result.ok ? '' : result.errors.join('; ')).toBe(true);
    if (!result.ok) return;
    const quick = result.model.templates.get('farmer_quick');
    const fullRecord = result.model.templates.get('full_record');
    const openField = result.model.layouts.get('open_field');
    const lysimeter = result.model.layouts.get('lysimeter');
    expect(quick).toBeDefined();
    expect(fullRecord).toBeDefined();
    expect(openField).toBeDefined();
    expect(lysimeter).toBeDefined();
    if (!quick || !fullRecord || !openField || !lysimeter) return;

    // irrigation Quick shows only the irrigation amount + note as its
    // activity-scoped content (operator/equipment/method are the separate,
    // always-visible carried_forward_details section, not part of this
    // activity's quick_fields, so they're excluded from this check).
    const irrigationStates = deriveFieldStates(quick, openField, { activity_code: 'irrigation' });
    const carryForwardCodes = new Set(quick.carry_forward);
    const irrigationAttributeCodes = irrigationStates
      .filter((state) => state.visible && state.code.startsWith('attr.') && !carryForwardCodes.has(state.code))
      .map((state) => state.code);
    expect(irrigationAttributeCodes).toEqual(['attr.irrigation_depth']);

    // fertilization Quick shows product + amount, never irrigation depth.
    const fertilizationStates = deriveFieldStates(quick, openField, { activity_code: 'fertilization' });
    const fertilizationAttributeCodes = fertilizationStates
      .filter((state) => state.visible && state.code.startsWith('attr.'))
      .map((state) => state.code);
    expect(fertilizationAttributeCodes).toEqual(expect.arrayContaining([
      'attr.product_uuid', 'attr.product', 'attr.amount_mass_area_product',
    ]));
    expect(fertilizationAttributeCodes).not.toContain('attr.irrigation_depth');
    expect(fertilizationAttributeCodes).not.toContain('attr.block_bed_row');

    // lysimeter fertilization Quick no longer shows the 8 reading fields.
    const lysimeterFertilization = deriveFieldStates(quick, lysimeter, { activity_code: 'fertilization' });
    const lysimeterReadingCodes = lysimeter.reading_fields ?? [];
    for (const readingCode of lysimeterReadingCodes) {
      expect(lysimeterFertilization.some((state) => state.code === readingCode && state.visible))
        .toBe(false);
    }
    // ...but they do show up for the sampling activity on that same layout.
    const lysimeterSampling = deriveFieldStates(quick, lysimeter, { activity_code: 'sampling' });
    for (const readingCode of lysimeterReadingCodes) {
      expect(lysimeterFertilization === lysimeterSampling).toBe(false);
      expect(lysimeterSampling.some((state) => state.code === readingCode && state.visible)).toBe(true);
    }

    // Regression: full_record resolution against the v3 layout bump differs
    // from the frozen v1 layout definitions in exactly one, intentional way
    // — journal capture-followups Slice 1 (Task 1.1b) relaxes a
    // minimum_fields entry to visible-but-optional whenever it is also
    // listed in that layout's own static_context_fields. lysimeter@3's
    // static_context_fields is the *entire* minimum_fields set (experimental
    // unit/replicate/treatment/surface_area — see journal-catalog-core.js),
    // so every one of those four flips from required to optional under v3;
    // field codes/order and every other field's requiredness stay identical
    // to v1.
    const rows = fixture.layouts.filter((row) => row.code === 'lysimeter' && row.version === 1);
    expect(rows).toHaveLength(1);
    // Re-parse the frozen v1 row directly (bypassing activeDefinition's
    // "latest version wins" resolution) so this is a true v1-vs-v3 diff.
    const v1Layout = (() => {
      const parsed = buildCatalogModel({
        ...fixture,
        layouts: fixture.layouts.filter((row) => !(row.code === 'lysimeter' && row.version === 3)),
      });
      return parsed.ok ? parsed.model.layouts.get('lysimeter') : undefined;
    })();
    expect(v1Layout?.version).toBe(1);
    const lysimeterStaticContextFields = new Set(lysimeter.static_context_fields ?? []);
    for (const activityCode of ['irrigation', 'fertilization', 'sampling']) {
      const selections = { activity_code: activityCode };
      const againstV1 = deriveFieldStates(fullRecord, v1Layout!, selections);
      const againstV3 = deriveFieldStates(fullRecord, lysimeter, selections);
      const expectedAgainstV3 = againstV1.map((state) =>
        lysimeterStaticContextFields.has(state.code) ? { ...state, required: false } : state);
      expect(againstV3).toEqual(expectedAgainstV3);
    }
  });

  it('Slice E: resolves activity-scoped Full visibility against the real shipped catalog', () => {
    const fixture = shippedCatalog();
    const result = buildCatalogModel(fixture);
    expect(result.ok, result.ok ? '' : result.errors.join('; ')).toBe(true);
    if (!result.ok) return;
    const fullRecord = result.model.templates.get('full_record');
    const openField = result.model.layouts.get('open_field');
    expect(fullRecord).toBeDefined();
    expect(openField).toBeDefined();
    if (!fullRecord || !openField) return;

    // full_record now resolves to the scoped v7 row (activeDefinition always
    // picks the highest active version — v7 is the journal capture-followups
    // Slice 1 irrigation-requiredness relaxation, layered on the v5
    // scoped_by_activity mechanism this slice introduced), and it still
    // declares the section this slice narrows.
    expect(fullRecord.version).toBe(7);
    const operationSection = fullRecord.sections.find((section) => section.code === 'operation');
    expect(operationSection?.scoped_by_activity).toBe(true);
    expect(fullRecord.operation_fields_by_activity).toBeDefined();

    // Full irrigation: shows the irrigation-details fields, excludes
    // product-mass/nutrient/harvest fields (spec §4-B).
    const irrigationStates = deriveFieldStates(fullRecord, openField, { activity_code: 'irrigation' });
    const irrigationVisible = irrigationStates.filter((state) => state.visible).map((state) => state.code);
    expect(irrigationVisible).toEqual(expect.arrayContaining([
      'attr.irrigation_amount_kind', 'attr.measurement_source', 'attr.denominator',
      'attr.irrigation_depth', 'attr.operator', 'attr.equipment', 'attr.method',
    ]));
    for (const excluded of [
      'attr.product_uuid', 'attr.product', 'attr.amount_mass_area_product',
      'attr.amount_volume_area_product', 'attr.amount_nutrient_rate',
      'attr.amount_count_area', 'attr.amount_biological_count_area',
      'attr.harvest_area', 'attr.harvest_yield_area', 'attr.crop',
    ]) {
      expect(irrigationVisible, `irrigation must exclude ${excluded}`).not.toContain(excluded);
    }
    // requiredness (journal capture-followups Slice 1, W1): the
    // irrigation_details conditional_group still forces amount_kind
    // required, and the depth/volume/per-plant family stays a required_any
    // trio; measurement_source/denominator moved to optional (visible, not
    // required) at full_record@7.
    expect(irrigationStates.find((state) => state.code === 'attr.irrigation_amount_kind'))
      .toMatchObject({ required: true });
    expect(irrigationStates.find((state) => state.code === 'attr.measurement_source'))
      .toMatchObject({ required: false });
    expect(irrigationStates.find((state) => state.code === 'attr.denominator'))
      .toMatchObject({ required: false });
    expect(irrigationStates.find((state) => state.code === 'attr.irrigation_depth')?.required_any_groups.length)
      .toBeGreaterThan(0);

    // Full fertilization: shows product/amount/treated-area/operator fields,
    // excludes irrigation-depth/plant-count/biological fields (spec §4-B).
    const fertilizationStates = deriveFieldStates(fullRecord, openField, { activity_code: 'fertilization' });
    const fertilizationVisible = fertilizationStates.filter((state) => state.visible).map((state) => state.code);
    expect(fertilizationVisible).toEqual(expect.arrayContaining([
      'attr.product_uuid', 'attr.product', 'attr.treated_area',
      'attr.amount_mass_area_product', 'attr.amount_volume_area_product', 'attr.amount_nutrient_rate',
      'attr.operator', 'attr.equipment', 'attr.method',
    ]));
    for (const excluded of [
      // NOTE: attr.denominator is deliberately absent from this list — the
      // open_field layout's own minimum_fields force it visible for every
      // activity/template regardless of the operation section's scoping, so
      // its presence here would prove nothing about Slice E.
      'attr.irrigation_depth', 'attr.irrigation_volume_area', 'attr.per_plant_volume',
      'attr.irrigation_amount_kind', 'attr.measurement_source',
      'attr.actuation_expectation_id', 'attr.amount_count_area', 'attr.amount_biological_count_area',
      'attr.harvest_area', 'attr.harvest_yield_area', 'attr.crop',
    ]) {
      expect(fertilizationVisible, `fertilization must exclude ${excluded}`).not.toContain(excluded);
    }
    expect(fertilizationStates.find((state) => state.code === 'attr.treated_area'))
      .toMatchObject({ required: true });
    expect(fertilizationStates.find((state) => state.code === 'attr.product_uuid')?.required_any_groups.length)
      .toBeGreaterThan(0);
  });

  it('journal capture-followups Slice 1 (W1): full_record@7 + open_field@3 irrigation relaxes measurement_source/denominator/block_bed_row/cover_type to visible-but-optional, keeping amount_kind/amount/treated_area required', () => {
    const fixture = shippedCatalog();
    const result = buildCatalogModel(fixture);
    expect(result.ok, result.ok ? '' : result.errors.join('; ')).toBe(true);
    if (!result.ok) return;
    const fullRecord = result.model.templates.get('full_record');
    const openField = result.model.layouts.get('open_field');
    expect(fullRecord).toBeDefined();
    expect(openField).toBeDefined();
    if (!fullRecord || !openField) return;
    expect(fullRecord.version).toBe(7);
    expect(openField.version).toBe(3);

    const states = deriveFieldStates(fullRecord, openField, { activity_code: 'irrigation' });
    const byCode = new Map(states.map((state) => [state.code, state]));

    // Required: amount_kind (irrigation_details.required, Task 1.1a) + the
    // depth/volume/per-plant required_any trio (one of, unchanged) +
    // treated_area (open_field's own minimum_fields — not in
    // static_context_fields, so Task 1.1b leaves it force-required).
    expect(byCode.get('attr.irrigation_amount_kind')).toMatchObject({ visible: true, required: true });
    expect(byCode.get('attr.treated_area')).toMatchObject({ visible: true, required: true });
    expect(byCode.get('attr.irrigation_depth')?.required_any_groups.length).toBeGreaterThan(0);

    // Visible but optional: measurement_source/denominator (moved from
    // irrigation_details.required to .optional at full_record@7 — Task
    // 1.1a) and block_bed_row/cover_type (open_field@3's
    // static_context_fields, relaxed by the templateEngine decouple — Task
    // 1.1b). denominator is relaxed by both mechanisms at once.
    for (const optionalCode of [
      'attr.measurement_source', 'attr.denominator', 'attr.block_bed_row', 'attr.cover_type',
    ]) {
      expect(byCode.get(optionalCode), optionalCode).toMatchObject({ visible: true, required: false });
    }

    // static_context_fields itself must stay populated (Fable B2/B3 guard,
    // Global Constraint 7) — the decouple must never empty it to relax
    // requiredness, since Quick's plot-context feature still reads it.
    expect(openField.static_context_fields).toEqual(
      expect.arrayContaining(['attr.block_bed_row', 'attr.cover_type', 'attr.denominator']),
    );

    // Quick capture is unaffected: farmer_quick resolves visibility entirely
    // via quick_fields and never force-adds layout minimum_fields (it always
    // skipped that branch, before and after this slice), so block_bed_row is
    // still not force-required — or even present — there.
    const farmerQuick = result.model.templates.get('farmer_quick');
    expect(farmerQuick).toBeDefined();
    if (!farmerQuick) return;
    const quickStates = deriveFieldStates(farmerQuick, openField, { activity_code: 'irrigation' });
    expect(quickStates.some((state) => state.code === 'attr.block_bed_row')).toBe(false);
  });

  it('journal capture-followups Slice 1 (W3): attr.crop exposes the 16 open-field vegetables, active with correct English labels and sort_order', () => {
    const fixture = shippedCatalog();
    const result = buildCatalogModel(fixture);
    expect(result.ok, result.ok ? '' : result.errors.join('; ')).toBe(true);
    if (!result.ok) return;

    const expectedVegetables: Array<[string, string, number]> = [
      ['choice.crop.carrot', 'Carrot', 3500],
      ['choice.crop.onion', 'Onion', 3504],
      ['choice.crop.leek', 'Leek', 3508],
      ['choice.crop.cabbage', 'Cabbage', 3512],
      ['choice.crop.cauliflower', 'Cauliflower', 3516],
      ['choice.crop.broccoli', 'Broccoli', 3520],
      ['choice.crop.lettuce', 'Lettuce', 3524],
      ['choice.crop.spinach', 'Spinach', 3528],
      ['choice.crop.celeriac', 'Celeriac', 3532],
      ['choice.crop.fennel', 'Fennel', 3536],
      ['choice.crop.table_beet', 'Table beet', 3540],
      ['choice.crop.courgette', 'Courgette / zucchini', 3544],
      ['choice.crop.pumpkin_squash', 'Pumpkin / squash', 3548],
      ['choice.crop.sweetcorn', 'Sweetcorn', 3552],
      ['choice.crop.garden_pea', 'Garden pea', 3556],
      ['choice.crop.green_bean', 'Green bean', 3560],
    ];
    for (const [code, label, sortOrder] of expectedVegetables) {
      const row = result.model.vocabByCode.get(code);
      expect(row, code).toBeDefined();
      if (!row) continue;
      expect(row.kind, code).toBe('choice');
      expect(row.parent_code, code).toBe('attr.crop');
      expect(row.active, code).toBe(1);
      expect(row.deleted_at, code).toBeNull();
      expect(row.sort_order, code).toBe(sortOrder);
      expect(row.labels, code).toEqual({ en: label });
      expect(catalogLabel(row, 'en'), code).toBe(label);
    }

    // Sort order places the vegetables after the Agroscope arable-crop range
    // (~3000-3025) and before the generic v4 buckets (4000-4040) — the
    // active-choice UI list (activeCropChoices/attr.crop dropdown) must show
    // them in exactly this position, not interleaved incorrectly.
    const cropChoiceSortOrders = [...result.model.vocabByCode.values()]
      .filter((row) => row.kind === 'choice' && row.parent_code === 'attr.crop' && row.active === 1)
      .map((row) => row.sort_order)
      .sort((a, b) => a - b);
    const minVegetableSort = Math.min(...expectedVegetables.map(([, , sortOrder]) => sortOrder));
    const maxVegetableSort = Math.max(...expectedVegetables.map(([, , sortOrder]) => sortOrder));
    const belowRange = cropChoiceSortOrders.filter((sortOrder) => sortOrder < minVegetableSort);
    const aboveRange = cropChoiceSortOrders.filter((sortOrder) => sortOrder > maxVegetableSort);
    expect(Math.max(...belowRange)).toBeLessThan(3100); // Agroscope arable-crop range
    expect(Math.min(...aboveRange)).toBeGreaterThanOrEqual(4000); // generic v4 buckets
  });

  it("Slice E: full_record's scoped_by_activity change leaves farmer_quick/research_observation resolution byte-for-byte unchanged", () => {
    const fixture = shippedCatalog();
    const result = buildCatalogModel(fixture);
    expect(result.ok, result.ok ? '' : result.errors.join('; ')).toBe(true);
    if (!result.ok) return;
    const quick = result.model.templates.get('farmer_quick');
    const research = result.model.templates.get('research_observation');
    const openField = result.model.layouts.get('open_field');
    expect(quick).toBeDefined();
    expect(research).toBeDefined();
    expect(openField).toBeDefined();
    if (!quick || !research || !openField) return;

    // Neither template declares (or can ever trigger) the new
    // scoped_by_activity/operation_fields_by_activity mechanism: it is
    // full_record@5-only. This structural guarantee is what makes the exact
    // snapshots below a genuine "unaffected by this slice" regression check,
    // not a coincidence.
    expect(quick.sections.some((section) => section.scoped_by_activity)).toBe(false);
    expect(quick.operation_fields_by_activity).toBeUndefined();
    expect(research.sections.some((section) => section.scoped_by_activity)).toBe(false);
    expect(research.operation_fields_by_activity).toBeUndefined();

    const state = (code: string, required = false) =>
      ({ code, visible: true, required, required_any_groups: [] });

    expect(deriveFieldStates(quick, openField, { activity_code: 'irrigation' })).toEqual([
      state('activity_code'), state('plot_uuid'), state('occurred_start'),
      state('attr.operator'), state('attr.equipment'), state('attr.method'),
      state('attr.irrigation_depth'), state('note'),
    ]);
    expect(deriveFieldStates(quick, openField, { activity_code: 'fertilization' })).toEqual([
      state('activity_code'), state('plot_uuid'), state('occurred_start'),
      state('attr.operator'), state('attr.equipment'), state('attr.method'),
      state('attr.product_uuid'), state('attr.product'),
      state('attr.amount_mass_area_product'), state('attr.amount_volume_area_product'),
      state('attr.amount_nutrient_rate'), state('note'),
    ]);
    // Slice F (F1): farmer_quick@6 adds attr.growth_stage_bbch as a
    // Quick-optional field for harvest (among the other four named
    // activities) — this is the one activity this "byte-for-byte unchanged
    // [by Slice E]" snapshot legitimately differs on now that farmer_quick
    // resolves to @6 instead of @3.
    expect(deriveFieldStates(quick, openField, { activity_code: 'harvest' })).toEqual([
      state('activity_code'), state('plot_uuid'), state('occurred_start'),
      state('attr.operator'), state('attr.equipment'), state('attr.method'),
      state('attr.harvest_yield_area'), state('attr.growth_stage_bbch'), state('note'),
    ]);

    // journal capture-followups Slice 1 (Task 1.1b): block_bed_row/
    // cover_type/denominator are open_field@3's static_context_fields, so the
    // templateEngine decouple resolves them visible-but-optional here too
    // (research_observation has no quick_fields, so it takes the same
    // non-quick minimum_fields branch full_record does); treated_area is not
    // in static_context_fields and stays required.
    const researchExpected = [
      state('activity_code'), state('plot_uuid'), state('occurred_start'),
      state('campaign_uuid'), state('protocol_code'), state('protocol_version'),
      state('observation_unit_code'), state('attr.observation_text'),
      state('attr.block_bed_row', false), state('attr.treated_area', true),
      state('attr.cover_type', false), state('attr.denominator', false),
    ];
    for (const activity of ['irrigation', 'fertilization', 'harvest']) {
      expect(deriveFieldStates(research, openField, { activity_code: activity })).toEqual(researchExpected);
    }
  });

  it('Slice F (F1): attr.growth_stage_bbch is a 0-99 number attribute that resolves visible into Full for every named activity', () => {
    const fixture = shippedCatalog();
    const bbch = fixture.vocab.find((entry) => entry.code === 'attr.growth_stage_bbch');
    expect(bbch).toMatchObject({ kind: 'attribute', value_type: 'number' });
    expect(bbch?.constraints).toMatchObject({ min: 0, max: 99, step: 1 });
    const bbchUnit = fixture.vocab.find((entry) => entry.code === bbch?.default_unit_code);
    expect(bbchUnit).toMatchObject({ kind: 'unit' });

    const result = buildCatalogModel(fixture);
    expect(result.ok, result.ok ? '' : result.errors.join('; ')).toBe(true);
    if (!result.ok) return;
    const fullRecord = result.model.templates.get('full_record');
    const openField = result.model.layouts.get('open_field');
    expect(fullRecord).toBeDefined();
    expect(openField).toBeDefined();
    if (!fullRecord || !openField) return;

    const bbchActivities = [
      'general_observation', 'pest_disease_observation', 'plant_protection_application',
      'crop_care', 'harvest',
    ];
    for (const activityCode of bbchActivities) {
      const states = deriveFieldStates(fullRecord, openField, { activity_code: activityCode });
      const bbchState = states.find((state) => state.code === 'attr.growth_stage_bbch');
      expect(bbchState, `${activityCode} must show attr.growth_stage_bbch`).toMatchObject({
        visible: true, required: false,
      });
    }
    for (const activityCode of ['irrigation', 'fertilization', 'tillage_soil_work', 'sampling']) {
      const states = deriveFieldStates(fullRecord, openField, { activity_code: activityCode });
      const bbchState = states.find((state) => state.code === 'attr.growth_stage_bbch');
      expect(bbchState?.visible ?? false, `${activityCode} must not show attr.growth_stage_bbch`).toBe(false);
    }
  });

  it("Slice F (F2): the weather-at-application group is visible+optional on plant_protection_application, and withWeatherAtApplicationVisibility hides it when the plot has a weather source", () => {
    const fixture = shippedCatalog();
    const result = buildCatalogModel(fixture);
    expect(result.ok, result.ok ? '' : result.errors.join('; ')).toBe(true);
    if (!result.ok) return;
    const fullRecord = result.model.templates.get('full_record');
    const openField = result.model.layouts.get('open_field');
    expect(fullRecord).toBeDefined();
    expect(openField).toBeDefined();
    if (!fullRecord || !openField) return;

    const weatherCodes = ['attr.wind_speed', 'attr.wind_direction', 'attr.air_temperature', 'attr.rel_humidity'];
    const sprayStates = deriveFieldStates(fullRecord, openField, { activity_code: 'plant_protection_application' });
    for (const code of weatherCodes) {
      expect(sprayStates.find((state) => state.code === code), `sensorless plot must show ${code}`)
        .toMatchObject({ visible: true, required: false });
    }
    // No other activity's operation_fields_by_activity ever declares these
    // codes, so a sensorless plot must not show them anywhere else either.
    const irrigationStates = deriveFieldStates(fullRecord, openField, { activity_code: 'irrigation' });
    for (const code of weatherCodes) {
      expect(irrigationStates.some((state) => state.code === code && state.visible)).toBe(false);
    }

    // Weather-source plot (GUI's zoneLinked === true): every weather field
    // must be forced invisible+not-required, everything else must be
    // untouched.
    const zoned = withWeatherAtApplicationVisibility(sprayStates, true);
    for (const code of weatherCodes) {
      expect(zoned.find((state) => state.code === code)).toMatchObject({ visible: false, required: false });
    }
    const nonWeather = sprayStates.filter((state) => !weatherCodes.includes(state.code));
    for (const state of nonWeather) {
      expect(zoned.find((candidate) => candidate.code === state.code)).toEqual(state);
    }

    // Sensorless plot (zoneLinked === false): identical to the untouched
    // states — a true no-op, not merely "still visible by coincidence".
    expect(withWeatherAtApplicationVisibility(sprayStates, false)).toEqual(sprayStates);
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

  // Shared home for the lookup DetailPanel.tsx and JournalTimeline.tsx each
  // used to declare locally, now reused by EntryTable.tsx/JournalEntryRow.tsx
  // too (P1, live UX pass): the client-side journal.json `activity.*` map
  // only ever covered 6 of the 16 shipped activity codes.
  it('resolves a vocab code to its catalog label via vocabLabelOrCode, falling back to the raw code when unresolved', () => {
    const result = buildCatalogModel(catalog());
    if (!result.ok) throw new Error('expected a valid catalog model');

    expect(vocabLabelOrCode('irrigation', result.model, 'de-CH')).toBe('irrigation-de');
    expect(vocabLabelOrCode('irrigation', result.model, 'fr')).toBe('irrigation');
    expect(vocabLabelOrCode('not_a_real_code', result.model, 'en')).toBe('not_a_real_code');
    expect(vocabLabelOrCode('irrigation', null, 'en')).toBe('irrigation');
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
    // v3 (Slice BC) and v6 (Slice F) are both newer than v2 and would
    // otherwise shadow it here (activeDefinition picks the highest version),
    // so this historical P4-fix regression test isolates v1+v2 explicitly to
    // keep proving what it always proved: v2 itself carries a valid, visible
    // carry_forward.
    const fixture: JournalCatalog = {
      ...shippedCatalog(),
      templates: shippedCatalog().templates.filter((row) =>
        !(row.code === 'farmer_quick' && (row.version === 3 || row.version === 6))),
    };
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

    // v3 (Slice BC) and v6 (Slice F) are both newer farmer_quick versions
    // that would otherwise become the active definition once v2 is removed
    // below, silently defeating this historical guard (both also carry a
    // valid, visible carry_forward — the point being tested here is
    // specifically about v1 vs v2). Isolate v1+v2 explicitly so this keeps
    // proving the P4 fix regardless of how many newer versions the catalog
    // gains.
    const v1v2OnlyFixture: JournalCatalog = {
      ...fullFixture,
      templates: fullFixture.templates.filter((row) =>
        !(row.code === 'farmer_quick' && (row.version === 3 || row.version === 6))),
    };

    // If farmer_quick@2 were ever missing (the pre-Task-27 world), @1 would
    // become the active definition again — and the parseTemplate guard
    // (catalogModel.ts) now correctly fails the whole model closed rather
    // than silently shipping a quick-entry template that carries values
    // nobody can see. This is deliberately re-derived from the *real*
    // catalog content on every run, so it keeps proving the fix forever
    // instead of only at the moment this test was written.
    const v1OnlyFixture: JournalCatalog = {
      ...v1v2OnlyFixture,
      templates: v1v2OnlyFixture.templates.filter((row) =>
        !(row.code === 'farmer_quick' && row.version === 2)),
    };
    const v1OnlyResult = buildCatalogModel(v1OnlyFixture);
    expect(v1OnlyResult.ok).toBe(false);
    if (v1OnlyResult.ok) return;
    expect(v1OnlyResult.errors.join('; ')).toMatch(/farmer_quick/);

    // With the real v1+v2 catalog (v1 frozen + v2 active), the pipeline
    // must visibly mark operator/equipment/method as carried-forward fields
    // and include all three in the final submitted payload.
    const result = buildCatalogModel(v1v2OnlyFixture);
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
