import { describe, expect, it } from 'vitest';

import {
  buildEntryValues,
  deriveFieldStates,
  evaluatePredicate,
  normalizeFieldRule,
} from '../templateEngine';
import { buildCatalogModel } from '../catalogModel';
import type { JournalCatalog, JournalDefinitionRow, JournalVocabRow } from '../../types/journal';

const timestamp = '2026-07-15T00:00:00.000Z';

function row(code: string, overrides: Partial<JournalVocabRow>): JournalVocabRow {
  return {
    code,
    kind: 'attribute',
    parent_code: null,
    value_type: 'text',
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

function def(code: string, definition: Record<string, unknown>): JournalDefinitionRow {
  return { code, version: 1, active: 1, catalog_errors: [], definition };
}

function valueCatalog(): JournalCatalog {
  return {
    catalog_version: 1,
    catalog_hash: 'values',
    vocab: [
      row('irrigation', { kind: 'activity', value_type: null }),
      row('fertilization', { kind: 'activity', value_type: null }),
      row('attr.amount', {
        value_type: 'number',
        quantity_kind: 'mass_area',
        basis: 'product_mass_per_area',
        default_unit_code: 'unit.kg_per_ha',
        constraints: { min: 0 },
      }),
      row('attr.note', { value_type: 'text' }),
      row('attr.flag', { value_type: 'boolean' }),
      row('attr.extra', { value_type: 'text' }),
      row('unit.kg_per_ha', {
        kind: 'unit',
        value_type: null,
        quantity_kind: 'mass_area',
        basis: 'product_mass_per_area',
        constraints: {
          dimension: 'product_mass_per_area',
          to_canonical: { unit_code: 'unit.kg_per_ha', scale: 1, offset: 0 },
        },
      }),
      row('unit.g_per_m2', {
        kind: 'unit',
        value_type: null,
        quantity_kind: 'mass_area',
        basis: 'product_mass_per_area',
        constraints: {
          dimension: 'product_mass_per_area',
          to_canonical: { unit_code: 'unit.kg_per_ha', scale: 10, offset: 0 },
        },
      }),
    ],
    templates: [def('full_record', { fields: ['activity_code'] })],
    layouts: [def('open_field', {
      activity_codes: ['irrigation', 'fertilization'],
      supported_templates: ['full_record'],
      option_dependencies: [],
    })],
    products: [],
    mappings: [],
  };
}

describe('template engine', () => {
  it('normalizes string and every accepted object field alias', () => {
    expect(normalizeFieldRule('attr.note')).toEqual({ code: 'attr.note', required: false });
    expect(normalizeFieldRule({ code: 'attr.note', required: true })).toEqual({
      code: 'attr.note',
      required: true,
    });
    expect(normalizeFieldRule({ attribute_code: 'attr.note' })?.code).toBe('attr.note');
    expect(normalizeFieldRule({ field: 'attr.note' })?.code).toBe('attr.note');
    expect(normalizeFieldRule({ code: 2 })).toBeNull();
  });

  it('supports only strict eq and in predicates', () => {
    expect(evaluatePredicate(
      { field: 'activity_code', op: 'eq', value: 'irrigation' },
      { activity_code: 'irrigation' },
    )).toEqual({ valid: true, matches: true });
    expect(evaluatePredicate(
      { field: 'activity_code', op: 'in', value: ['irrigation', 'fertigation'] },
      { activity_code: ['fertilization', 'irrigation'] },
    )).toEqual({ valid: true, matches: true });
    expect(evaluatePredicate(
      { field: 'activity_code', op: 'contains', value: 'irrigation' },
      { activity_code: 'irrigation' },
    )).toEqual({ valid: false, matches: false });
  });

  it('derives ordered deduplicated visibility and conditional requiredness', () => {
    const template = {
      code: 'full_record',
      version: 1,
      fields: [
        'activity_code',
        { attribute_code: 'attr.note', required: true },
        {
          field: 'attr.flag',
          visible_if: { field: 'activity_code', op: 'eq', value: 'irrigation' },
          required_if: { field: 'activity_code', op: 'in', value: ['irrigation'] },
        },
      ],
      sections: [{ code: 'again', fields: ['attr.note'] }],
      activity_requirements: {
        irrigation: { required: ['attr.extra'], required_any: [['attr.note', 'attr.flag']] },
      },
      conditional_groups: [{
        code: 'irrigation_details',
        activity_codes: ['irrigation'],
        required: ['attr.amount'],
      }],
    };
    const layout = {
      code: 'open_field',
      version: 1,
      activity_codes: ['irrigation'],
      supported_templates: ['full_record'],
      fields: ['attr.extra'],
      minimum_fields: ['attr.note'],
      conditional_fields: { solution_managed: ['attr.amount'] },
      option_dependencies: [],
    };

    const states = deriveFieldStates(template, layout, {
      activity_code: 'irrigation',
      solution_managed: true,
    });
    expect(states.map(({ code }) => code)).toEqual([
      'activity_code',
      'attr.note',
      'attr.flag',
      'attr.extra',
      'attr.amount',
    ]);
    expect(states.find(({ code }) => code === 'attr.flag')).toMatchObject({
      visible: true,
      required: true,
      required_any_groups: [0],
    });
    expect(states.find(({ code }) => code === 'attr.extra')?.required).toBe(true);
    expect(states.find(({ code }) => code === 'attr.amount')?.required).toBe(true);
    expect(deriveFieldStates(template, layout, { activity_code: 'fertilization' })
      .find(({ code }) => code === 'attr.flag')?.visible).toBe(false);
  });

  describe('Slice BC: quick_fields activity-scoping (R1)', () => {
    const quickTemplate = {
      code: 'farmer_quick',
      version: 3,
      sections: [
        { code: 'what_where_when', fields: ['activity_code', 'plot_uuid'] },
      ],
      quick_fields: {
        irrigation: ['attr.irrigation_depth', 'note'],
        fertilization: ['attr.product_uuid', 'attr.amount_mass_area_product', 'note'],
        sampling: ['note'],
      },
    };
    const fullRecordTemplate = {
      code: 'full_record',
      version: 1,
      fields: ['activity_code'],
    };
    const layoutV1 = {
      code: 'lysimeter',
      version: 1,
      activity_codes: ['irrigation', 'fertilization', 'sampling'],
      supported_templates: ['farmer_quick', 'full_record'],
      minimum_fields: ['attr.block_bed_row', 'attr.mass_start', 'attr.mass_end'],
      conditional_fields: {},
      option_dependencies: [],
    };
    const layoutV3 = {
      ...layoutV1,
      version: 3,
      minimum_fields: ['attr.block_bed_row'],
      static_context_fields: ['attr.block_bed_row'],
      reading_fields: ['attr.mass_start', 'attr.mass_end'],
    };

    it('scopes Quick visibility to only the selected activity\'s quick_fields', () => {
      const irrigationStates = deriveFieldStates(quickTemplate, layoutV3, { activity_code: 'irrigation' });
      expect(irrigationStates.filter((s) => s.visible).map((s) => s.code).sort()).toEqual(
        ['activity_code', 'attr.irrigation_depth', 'note', 'plot_uuid'].sort(),
      );
      expect(irrigationStates.find((s) => s.code === 'attr.irrigation_depth')?.required).toBe(false);
      expect(irrigationStates.some((s) => s.code === 'attr.block_bed_row')).toBe(false);

      const fertilizationStates = deriveFieldStates(quickTemplate, layoutV3, { activity_code: 'fertilization' });
      expect(fertilizationStates.filter((s) => s.visible).map((s) => s.code).sort()).toEqual(
        ['activity_code', 'attr.amount_mass_area_product', 'attr.product_uuid', 'note', 'plot_uuid'].sort(),
      );
      expect(fertilizationStates.some((s) => s.code === 'attr.irrigation_depth')).toBe(false);
      expect(fertilizationStates.some((s) => s.code === 'attr.block_bed_row')).toBe(false);
    });

    it('adds the layout\'s reading_fields only for the sampling activity', () => {
      const fertilizationStates = deriveFieldStates(quickTemplate, layoutV3, { activity_code: 'fertilization' });
      expect(fertilizationStates.some((s) => s.code === 'attr.mass_start')).toBe(false);
      expect(fertilizationStates.some((s) => s.code === 'attr.mass_end')).toBe(false);

      const samplingStates = deriveFieldStates(quickTemplate, layoutV3, { activity_code: 'sampling' });
      const visibleCodes = samplingStates.filter((s) => s.visible).map((s) => s.code);
      expect(visibleCodes).toEqual(expect.arrayContaining(['attr.mass_start', 'attr.mass_end', 'note']));
      expect(visibleCodes).not.toContain('attr.block_bed_row');
    });

    it('falls back to a minimal field set for an activity with no quick_fields entry', () => {
      const states = deriveFieldStates(quickTemplate, layoutV3, { activity_code: 'unmapped_activity' });
      const visibleAttributeOrNoteCodes = states
        .filter((s) => s.visible && (s.code === 'note' || s.code.startsWith('attr.')))
        .map((s) => s.code);
      expect(visibleAttributeOrNoteCodes).toEqual(['note']);
    });

    it('leaves full_record/research (no quick_fields) resolution unaffected by the v1 -> v3 layout bump', () => {
      const selections = { activity_code: 'fertilization' };
      const statesAgainstV1 = deriveFieldStates(fullRecordTemplate, layoutV1, selections);
      const statesAgainstV3 = deriveFieldStates(fullRecordTemplate, layoutV3, selections);
      expect(statesAgainstV3).toEqual(statesAgainstV1);
      // And the reading fields the v1 minimum_fields used to force directly
      // are still forced-visible+required via v3's reading_fields reunion.
      expect(statesAgainstV3.find((s) => s.code === 'attr.mass_start')).toMatchObject({
        visible: true,
        required: true,
      });
    });
  });

  describe('Slice E: scoped_by_activity operation-section visibility (R5)', () => {
    const scopedTemplate = {
      code: 'full_record',
      version: 5,
      sections: [
        { code: 'identity', fields: ['activity_code', 'plot_uuid'] },
        {
          code: 'operation',
          scoped_by_activity: true,
          fields: ['attr.irrigation_depth', 'attr.product_uuid', 'attr.harvest_yield_area', 'attr.operator'],
        },
        { code: 'notes', fields: ['note'] },
      ],
      operation_fields_by_activity: {
        irrigation: ['attr.irrigation_depth', 'attr.operator'],
        fertilization: ['attr.product_uuid', 'attr.operator'],
      },
      activity_requirements: {
        fertilization: { required: ['attr.product_uuid'], optional: [], required_any: [] },
      },
    };
    const layout = {
      code: 'open_field',
      version: 1,
      activity_codes: ['irrigation', 'fertilization'],
      supported_templates: ['full_record'],
      minimum_fields: [],
      conditional_fields: {},
      option_dependencies: [],
    };

    it("narrows a scoped_by_activity section to that activity's operation_fields_by_activity entry", () => {
      const irrigationCodes = deriveFieldStates(scopedTemplate, layout, { activity_code: 'irrigation' })
        .filter((state) => state.visible)
        .map((state) => state.code);
      expect(irrigationCodes).toEqual(
        expect.arrayContaining(['activity_code', 'plot_uuid', 'attr.irrigation_depth', 'attr.operator', 'note']),
      );
      expect(irrigationCodes).not.toContain('attr.product_uuid');
      expect(irrigationCodes).not.toContain('attr.harvest_yield_area');

      const fertilizationCodes = deriveFieldStates(scopedTemplate, layout, { activity_code: 'fertilization' })
        .filter((state) => state.visible)
        .map((state) => state.code);
      expect(fertilizationCodes).toEqual(
        expect.arrayContaining(['activity_code', 'plot_uuid', 'attr.product_uuid', 'attr.operator', 'note']),
      );
      expect(fertilizationCodes).not.toContain('attr.irrigation_depth');
      expect(fertilizationCodes).not.toContain('attr.harvest_yield_area');
    });

    it('never hides a field the activity_requirements/conditional_groups mark required, even when the scoped map narrows it out', () => {
      // fertilization's scoped map narrows the operation section to
      // product_uuid + operator only, but activity_requirements independently
      // requires attr.product_uuid — addRequirement's force-add must win
      // regardless of the narrowing (this is the load-bearing guarantee the
      // catalog-side design comment calls out: the map can only ever trim
      // *optional* clutter, never smuggle out a required field).
      const states = deriveFieldStates(scopedTemplate, layout, { activity_code: 'fertilization' });
      const productState = states.find((state) => state.code === 'attr.product_uuid');
      expect(productState).toMatchObject({ visible: true, required: true });
    });

    it('shows nothing from the scoped section until an activity is selected', () => {
      const states = deriveFieldStates(scopedTemplate, layout, {});
      const visibleOperationCodes = states
        .filter((state) => state.visible &&
          ['attr.irrigation_depth', 'attr.product_uuid', 'attr.harvest_yield_area', 'attr.operator']
            .includes(state.code))
        .map((state) => state.code);
      expect(visibleOperationCodes).toEqual([]);
    });

    it('leaves an ordinary (non-scoped) section fully unaffected', () => {
      const states = deriveFieldStates(scopedTemplate, layout, { activity_code: 'irrigation' });
      expect(states.find((state) => state.code === 'activity_code')?.visible).toBe(true);
      expect(states.find((state) => state.code === 'plot_uuid')?.visible).toBe(true);
      expect(states.find((state) => state.code === 'note')?.visible).toBe(true);
    });
  });

  it('builds exact canonical and entered numeric facts without generic value', () => {
    const result = buildCatalogModel(valueCatalog());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const values = buildEntryValues(result.model, [
      {
        attribute_code: 'attr.amount',
        entered_value_num: 2,
        entered_unit_code: 'unit.g_per_m2',
      },
      {
        attribute_code: 'attr.amount',
        value: 0,
        entered_unit_code: 'unit.g_per_m2',
      },
      { attribute_code: 'attr.note', value: 'done', group_index: 2 },
      { attribute_code: 'attr.flag', value: false },
      { attribute_code: 'attr.note', value: '' },
      { attribute_code: 'attr.note', value_status: 'not_observed' },
    ]);

    expect(values).toEqual([
      {
        attribute_code: 'attr.amount',
        value_num: 20,
        unit_code: 'unit.kg_per_ha',
        entered_value_num: 2,
        entered_unit_code: 'unit.g_per_m2',
      },
      {
        attribute_code: 'attr.amount',
        value_num: 0,
        unit_code: 'unit.kg_per_ha',
        entered_value_num: 0,
        entered_unit_code: 'unit.g_per_m2',
      },
      { attribute_code: 'attr.note', value: 'done', group_index: 2 },
      { attribute_code: 'attr.flag', value: false },
      { attribute_code: 'attr.note', value_status: 'not_observed' },
    ]);
    expect(values[0]).not.toHaveProperty('value');
  });

  it('accepts a numeric generic value only when it equals the canonical value', () => {
    const result = buildCatalogModel(valueCatalog());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(buildEntryValues(result.model, [{
      attribute_code: 'attr.amount',
      value: 20,
      entered_value_num: 2,
      entered_unit_code: 'unit.g_per_m2',
    }])).toHaveLength(1);
    expect(() => buildEntryValues(result.model, [{
      attribute_code: 'attr.amount',
      value: 2,
      entered_value_num: 2,
      entered_unit_code: 'unit.g_per_m2',
    }])).toThrow(/canonical/i);
  });
});
