import { describe, expect, it } from 'vitest';

import { buildCatalogModel } from '../catalogModel';
import { computeLayoutTransitionDiff, layoutTransitionItemKey } from '../layoutTransition';
import type { JournalCatalog, JournalDefinitionRow, JournalVocabRow } from '../../types/journal';

const timestamp = '2026-07-19T00:00:00.000Z';

function row(code: string, overrides: Partial<JournalVocabRow> = {}): JournalVocabRow {
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

function choiceRow(code: string, parentCode: string): JournalVocabRow {
  return row(code, { kind: 'choice', parent_code: parentCode, value_type: null });
}

function def(code: string, definition: Record<string, unknown>, version = 1): JournalDefinitionRow {
  return { code, version, active: 1, catalog_errors: [], labels: { en: code }, definition };
}

function templateDefinition(fields: string[] = []): Record<string, unknown> {
  return {
    fields,
    sections: [],
    carry_forward: [],
    require_explicit_choices: false,
    show_standard_mappings: false,
    activity_requirements: {},
    conditional_groups: [],
    requirements: { required: [], optional: [], required_any: [] },
  };
}

const wideLayout = def('greenhouse', {
  activity_codes: ['irrigation'],
  supported_templates: ['full_record'],
  fields: ['attr.method', 'attr.note'],
  minimum_fields: [],
  conditional_fields: {},
  denominator_contract: [],
  option_dependencies: [],
}, 6);

const narrowLayout = def('open_field', {
  activity_codes: ['irrigation'],
  supported_templates: ['full_record'],
  fields: ['attr.method'],
  minimum_fields: [],
  conditional_fields: {},
  denominator_contract: [],
  option_dependencies: [{
    when: { attribute_code: 'activity_code', equals: 'irrigation' },
    restrict: { attribute_code: 'attr.method', choices: ['method.a'] },
  }],
}, 3);

function catalogWith(layouts: JournalDefinitionRow[]): JournalCatalog {
  return {
    catalog_version: 1,
    catalog_hash: 'transition',
    vocab: [
      row('irrigation', { kind: 'activity', value_type: null }),
      row('attr.method', { value_type: 'choice' }),
      choiceRow('method.a', 'attr.method'),
      choiceRow('method.b', 'attr.method'),
      row('attr.note', { value_type: 'text' }),
    ],
    templates: [def('full_record', templateDefinition())],
    layouts,
    products: [],
    mappings: [],
  };
}

function buildModel(layouts: JournalDefinitionRow[]) {
  const result = buildCatalogModel(catalogWith(layouts));
  if (!result.ok) throw new Error(`fixture catalog invalid: ${result.errors.join(', ')}`);
  return result.model;
}

const selections = { activity_code: 'irrigation' as const };

describe('computeLayoutTransitionDiff', () => {
  it('flags a choice value no longer allowed under the new layout', () => {
    const model = buildModel([wideLayout, narrowLayout]);
    const value = { attribute_code: 'attr.method', group_index: 0, value: 'method.b' };
    const items = computeLayoutTransitionDiff({
      model,
      oldLayout: model.layouts.get('greenhouse'),
      newLayout: model.layouts.get('open_field'),
      template: model.templates.get('full_record'),
      selections,
      currentValues: [value],
    });
    expect(items).toEqual([
      { attribute_code: 'attr.method', group_index: 0, reason: 'choice_invalid', value },
    ]);
  });

  it('flags a field no longer present under the new layout', () => {
    const model = buildModel([wideLayout, narrowLayout]);
    const value = { attribute_code: 'attr.note', value: 'temporary detail' };
    const items = computeLayoutTransitionDiff({
      model,
      oldLayout: model.layouts.get('greenhouse'),
      newLayout: model.layouts.get('open_field'),
      template: model.templates.get('full_record'),
      selections,
      currentValues: [value],
    });
    expect(items).toEqual([
      { attribute_code: 'attr.note', group_index: 0, reason: 'field_hidden', value },
    ]);
  });

  it('does not flag a value that stays valid and visible under the new layout', () => {
    const model = buildModel([wideLayout, narrowLayout]);
    const items = computeLayoutTransitionDiff({
      model,
      oldLayout: model.layouts.get('greenhouse'),
      newLayout: model.layouts.get('open_field'),
      template: model.templates.get('full_record'),
      selections,
      currentValues: [{ attribute_code: 'attr.method', value: 'method.a' }],
    });
    expect(items).toEqual([]);
  });

  it('returns no items when there is no prior layout to diff against', () => {
    const model = buildModel([wideLayout, narrowLayout]);
    const items = computeLayoutTransitionDiff({
      model,
      oldLayout: undefined,
      newLayout: model.layouts.get('open_field'),
      template: model.templates.get('full_record'),
      selections,
      currentValues: [{ attribute_code: 'attr.note', value: 'anything' }],
    });
    expect(items).toEqual([]);
  });

  it('ignores values without entered content', () => {
    const model = buildModel([wideLayout, narrowLayout]);
    const items = computeLayoutTransitionDiff({
      model,
      oldLayout: model.layouts.get('greenhouse'),
      newLayout: model.layouts.get('open_field'),
      template: model.templates.get('full_record'),
      selections,
      currentValues: [{ attribute_code: 'attr.note', value: '' }],
    });
    expect(items).toEqual([]);
  });

  it('preserves the original value object untouched on the affected item (no mutation, no sanitizing)', () => {
    const model = buildModel([wideLayout, narrowLayout]);
    const value = { attribute_code: 'attr.note', value: 'temporary detail', group_index: 3 };
    const items = computeLayoutTransitionDiff({
      model,
      oldLayout: model.layouts.get('greenhouse'),
      newLayout: model.layouts.get('open_field'),
      template: model.templates.get('full_record'),
      selections,
      currentValues: [value],
    });
    expect(items[0]?.value).toBe(value);
    expect(items[0]?.group_index).toBe(3);
  });

  it('returns no items when the new layout and template are unresolved', () => {
    const model = buildModel([wideLayout, narrowLayout]);
    const items = computeLayoutTransitionDiff({
      model,
      oldLayout: model.layouts.get('greenhouse'),
      newLayout: undefined,
      template: model.templates.get('full_record'),
      selections,
      currentValues: [{ attribute_code: 'attr.note', value: 'anything' }],
    });
    expect(items).toEqual([]);
  });
});

describe('layoutTransitionItemKey', () => {
  it('joins the attribute code and group index into a stable key', () => {
    expect(layoutTransitionItemKey('attr.note', 2)).toBe('attr.note:2');
    expect(layoutTransitionItemKey('attr.method', 0)).toBe('attr.method:0');
  });
});
