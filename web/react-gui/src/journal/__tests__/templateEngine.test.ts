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
