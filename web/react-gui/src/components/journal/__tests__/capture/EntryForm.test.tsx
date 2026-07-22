import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JournalProductRow, JournalVocabRow } from '../../../../types/journal';
import type {
  CaptureEntryValueInput,
  CaptureEntryValueOutput,
  JournalCaptureCatalogModel,
  JournalFieldState,
  JournalLayoutDefinition,
  JournalSelections,
} from '../../../../types/journalCapture';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { resolvedLanguage: 'en-GB', language: 'en-GB' },
  }),
}));

import { EntryForm, validateEntryForm } from '../../capture/EntryForm';

const reportConsoleError = console.error.bind(console);
const ACT_WARNING = /not wrapped in act|testing environment is not configured to support act/i;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

const timestamp = '2026-07-16T00:00:00.000Z';

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    reportConsoleError(...args);
  });
});

afterEach(() => {
  cleanup();
  const actWarnings = consoleErrorSpy.mock.calls.filter((args: unknown[]) =>
    args.some((value: unknown) => ACT_WARNING.test(String(value))));
  consoleErrorSpy.mockRestore();
  expect(actWarnings).toEqual([]);
});

function vocab(code: string, overrides: Partial<JournalVocabRow> = {}): JournalVocabRow {
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

function numericAttribute(
  code: string,
  quantityKind: string,
  basis: string,
  defaultUnit: string | null,
  constraints: Record<string, unknown> = {},
): JournalVocabRow {
  return vocab(code, {
    value_type: 'number',
    quantity_kind: quantityKind,
    basis,
    default_unit_code: defaultUnit,
    constraints: defaultUnit == null
      ? {
          ...constraints,
          requires_explicit_unit: true,
          allow_default_unit: false,
          semantic_discriminator: 'unit_code',
        }
      : constraints,
  });
}

function unit(
  code: string,
  label: string,
  quantityKind: string,
  basis: string,
  canonical: string,
  scale = 1,
): JournalVocabRow {
  return vocab(code, {
    kind: 'unit',
    value_type: null,
    quantity_kind: quantityKind,
    basis,
    labels: { en: label },
    constraints: {
      dimension: `${quantityKind}:${basis}`,
      to_canonical: { unit_code: canonical, scale, offset: 0 },
    },
  });
}

const rows = [
  vocab('tillage_soil_work', { kind: 'activity', value_type: null }),
  numericAttribute('attr.amount', 'mass_area', 'product', 'unit.kg', { min: 0, max: 2000, step: 0.5 }),
  numericAttribute('attr.duration', 'duration', 'time', 'unit.min'),
  numericAttribute(
    'attr.amount_operation_depth',
    'depth',
    'operation',
    'unit.cm_operation_depth',
  ),
  numericAttribute('attr.amount_nutrient_rate', 'nutrient_rate', 'nutrient', null, {
    min: 0,
    repeatable: true,
  }),
  vocab('attr.text', { labels: { en: 'Text field' } }),
  vocab('attr.when', { value_type: 'date', labels: { en: 'Date field' } }),
  vocab('attr.flag', { value_type: 'boolean', labels: { en: 'Boolean field' } }),
  vocab('attr.product_uuid', { labels: { en: 'Registered product' } }),
  vocab('attr.agroscope.operation', { value_type: 'choice', labels: { en: 'Operation' } }),
  vocab('attr.agroscope.device', { value_type: 'choice', labels: { en: 'Device' } }),
  vocab('agroscope.operation.primary_tillage', {
    kind: 'choice',
    parent_code: 'attr.agroscope.operation',
    value_type: null,
    labels: { en: 'Primary tillage' },
  }),
  vocab('agroscope.operation.seedbed_preparation', {
    kind: 'choice',
    parent_code: 'attr.agroscope.operation',
    value_type: null,
    labels: { en: 'Secondary tillage' },
  }),
  vocab('agroscope.device.plough', {
    kind: 'choice',
    parent_code: 'attr.agroscope.device',
    value_type: null,
    labels: { en: 'Plough' },
  }),
  vocab('agroscope.device.rotary_harrow', {
    kind: 'choice',
    parent_code: 'attr.agroscope.device',
    value_type: null,
    labels: { en: 'Harrow' },
  }),
  unit('unit.g', 'g/ha', 'mass_area', 'product', 'unit.kg', 0.001),
  unit('unit.kg', 'kg/ha', 'mass_area', 'product', 'unit.kg'),
  unit('unit.t', 't/ha', 'mass_area', 'product', 'unit.kg', 1000),
  unit('unit.min', 'min', 'duration', 'time', 'unit.min'),
  unit('unit.hour', 'h', 'duration', 'time', 'unit.min', 60),
  unit(
    'unit.cm_operation_depth',
    'cm',
    'depth',
    'operation',
    'unit.cm_operation_depth',
  ),
  unit(
    'unit.mm_operation_depth',
    'mm',
    'depth',
    'operation',
    'unit.cm_operation_depth',
    0.1,
  ),
  unit('unit.cross-basis', 'kg water/ha', 'mass_area', 'water', 'unit.cross-basis'),
  unit('unit.wrong-kind', 'L/ha', 'volume_area', 'product', 'unit.wrong-kind'),
  unit(
    'unit.kg_n_per_ha_nutrient',
    'kg N/ha',
    'nutrient_rate',
    'nutrient',
    'unit.kg_n_per_ha_nutrient',
  ),
  unit(
    'unit.kg_p2o5_per_ha_nutrient',
    'kg P₂O₅/ha',
    'nutrient_rate',
    'nutrient',
    'unit.kg_p2o5_per_ha_nutrient',
  ),
];

const model: JournalCaptureCatalogModel = {
  vocabByCode: new Map(rows.map((row) => [row.code, row])),
  templates: new Map(),
  layouts: new Map(),
};

const layout: JournalLayoutDefinition = {
  code: 'agroscope_open_field',
  version: 1,
  activity_codes: ['tillage_soil_work'],
  supported_templates: ['research_observation'],
  fields: [],
  minimum_fields: [],
  conditional_fields: {},
  denominator_contract: [],
  option_dependencies: [
    {
      when: { attribute_code: 'activity_code', equals: 'tillage_soil_work' },
      restrict: {
        attribute_code: 'attr.agroscope.operation',
        choices: [
          'agroscope.operation.primary_tillage',
          'agroscope.operation.seedbed_preparation',
        ],
      },
    },
    {
      when: {
        attribute_code: 'attr.agroscope.operation',
        equals: 'agroscope.operation.primary_tillage',
      },
      restrict: { attribute_code: 'attr.agroscope.device', choices: ['agroscope.device.plough'] },
    },
    {
      when: {
        attribute_code: 'attr.agroscope.operation',
        equals: 'agroscope.operation.seedbed_preparation',
      },
      restrict: {
        attribute_code: 'attr.agroscope.device',
        choices: ['agroscope.device.rotary_harrow'],
      },
    },
    {
      when: { attribute_code: 'attr.agroscope.device', equals: 'agroscope.device.plough' },
      restrict: { attribute_code: 'attr.amount_operation_depth', units: ['unit.cm_operation_depth'] },
    },
  ],
};

function state(code: string, overrides: Partial<JournalFieldState> = {}): JournalFieldState {
  return { code, visible: true, required: false, required_any_groups: [], ...overrides };
}

function ControlledForm({
  initialValues = [],
  fieldStates,
  selections = {},
  products = [],
  locale = 'en-GB',
  showValidation = false,
  templateCode,
  onResult,
}: {
  initialValues?: CaptureEntryValueInput[];
  fieldStates: JournalFieldState[];
  selections?: JournalSelections;
  products?: JournalProductRow[];
  locale?: string;
  showValidation?: boolean;
  templateCode?: string;
  onResult: (
    inputs: CaptureEntryValueInput[],
    payload: CaptureEntryValueOutput[],
    valid: boolean,
  ) => void;
}) {
  const [values, setValues] = useState(initialValues);
  return (
    <EntryForm
      model={model}
      layout={layout}
      fieldStates={fieldStates}
      values={values}
      selections={selections}
      products={products}
      locale={locale}
      showValidation={showValidation}
      templateCode={templateCode}
      onChange={(next, payload, valid) => {
        setValues(next);
        onResult(next, payload, valid);
      }}
    />
  );
}

describe('EntryForm', () => {
  it('exports the full validator and prunes parse errors for hidden numeric inputs', () => {
    const t = ((key: string) => key) as TFunction<'journal'>;
    const invalid = validateEntryForm({
      model,
      layout,
      fieldStates: [state('attr.amount')],
      inputs: [{
        attribute_code: 'attr.amount',
        entered_value_num: 2001,
        entered_unit_code: 'unit.kg',
      }],
      selections: {},
      numberInputErrors: new Map(),
      products: [],
      t,
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.get('attr.amount:0')).toBe('capture.validation.maximum');

    const hidden = validateEntryForm({
      model,
      layout,
      fieldStates: [state('attr.amount', { visible: false })],
      inputs: [{
        attribute_code: 'attr.amount',
        entered_value_num: 5,
        entered_unit_code: 'unit.kg',
      }],
      selections: {},
      numberInputErrors: new Map([['attr.amount', 'capture.validation.invalidNumber']]),
      products: [],
      t,
    });
    expect(hidden.valid).toBe(true);
    expect(hidden.payload).toEqual([]);
    expect(hidden.numberInputErrors.size).toBe(0);
  });

  it('treats a cleared optional numeric field (value null, residual unit) as blank, not an incompatible-unit error', () => {
    const t = ((key: string) => key) as TFunction<'journal'>;
    // A cleared prefilled field (e.g. optional attr.treated_area): numericInput
    // sets entered_value_num null but leaves the last-picked unit. Must be valid.
    const cleared = validateEntryForm({
      model,
      layout,
      fieldStates: [state('attr.amount')],
      inputs: [{ attribute_code: 'attr.amount', entered_value_num: null, entered_unit_code: 'unit.kg' }],
      selections: {},
      numberInputErrors: new Map(),
      products: [],
      t,
    });
    expect(cleared.valid).toBe(true);
    expect(cleared.errors.get('attr.amount:0')).toBeUndefined();

    // A value with no unit is still a genuine incompatible-unit error.
    const noUnit = validateEntryForm({
      model,
      layout,
      fieldStates: [state('attr.amount')],
      inputs: [{ attribute_code: 'attr.amount', entered_value_num: 5, entered_unit_code: undefined }],
      selections: {},
      numberInputErrors: new Map(),
      products: [],
      t,
    });
    expect(noUnit.valid).toBe(false);
    expect(noUnit.errors.get('attr.amount:0')).toBe('capture.validation.incompatibleUnit');

    // A *required* empty field is still blocked — by the required check, not the unit check.
    const requiredEmpty = validateEntryForm({
      model,
      layout,
      fieldStates: [state('attr.amount', { required: true })],
      inputs: [{ attribute_code: 'attr.amount', entered_value_num: null, entered_unit_code: 'unit.kg' }],
      selections: {},
      numberInputErrors: new Map(),
      products: [],
      t,
    });
    expect(requiredEmpty.valid).toBe(false);
    expect(requiredEmpty.errors.get('attr.amount')).toBe('capture.validation.required');
  });

  it('renders Task 8 number, text, choice, date, and boolean field states but excludes shell fields', () => {
    render(
      <ControlledForm
        fieldStates={[
          state('activity_code'),
          state('plot_uuid'),
          state('occurred_start'),
          state('note'),
          state('attr.amount'),
          state('attr.text'),
          state('attr.agroscope.operation'),
          state('attr.when'),
          state('attr.flag'),
        ]}
        selections={{ activity_code: 'tillage_soil_work' }}
        onResult={vi.fn()}
      />,
    );

    expect(screen.getByRole('textbox', { name: 'attr.amount' })).toHaveAttribute('inputmode', 'decimal');
    expect(screen.getByRole('textbox', { name: 'Text field' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Operation' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Date field/)).toHaveAttribute('type', 'date');
    expect(screen.getByRole('group', { name: 'Boolean field' })).toBeInTheDocument();
    expect(screen.queryByText('activity_code')).not.toBeInTheDocument();
    expect(screen.queryByText('plot_uuid')).not.toBeInTheDocument();
    expect(screen.queryByText('occurred_start')).not.toBeInTheDocument();
    expect(screen.queryByText('note')).not.toBeInTheDocument();
  });

  it('accepts an empty optional generic choice and emits no payload value', () => {
    const onResult = vi.fn();
    render(
      <ControlledForm
        fieldStates={[state('attr.agroscope.operation')]}
        initialValues={[{
          attribute_code: 'attr.agroscope.operation',
          value: 'agroscope.operation.primary_tillage',
        }]}
        selections={{ activity_code: 'tillage_soil_work' }}
        onResult={onResult}
      />,
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Operation' }), {
      target: { value: '' },
    });

    expect(onResult).toHaveBeenLastCalledWith(
      [{ attribute_code: 'attr.agroscope.operation', value: '' }],
      [],
      true,
    );
  });

  it('uses fixed, segmented, and select unit controls for one, two, and many allowed units', () => {
    render(
      <ControlledForm
        fieldStates={[
          state('attr.amount_operation_depth'),
          state('attr.duration'),
          state('attr.amount'),
        ]}
        selections={{
          activity_code: 'tillage_soil_work',
          'attr.agroscope.operation': 'agroscope.operation.primary_tillage',
          'attr.agroscope.device': 'agroscope.device.plough',
        }}
        onResult={vi.fn()}
      />,
    );

    expect(screen.getByText('cm')).toBeInTheDocument();
    expect(screen.queryByText('mm')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'min' })).toHaveAttribute('aria-pressed');
    expect(screen.getByRole('button', { name: 'h' })).toHaveAttribute('aria-pressed');
    const unitSelect = screen.getByRole('combobox', { name: 'capture.form.unit' });
    expect(within(unitSelect).getAllByRole('option')).toHaveLength(4);
  });

  it('emits exact entered and canonical values, including locale decimals and zero', () => {
    const onResult = vi.fn();
    render(
      <ControlledForm
        fieldStates={[state('attr.amount')]}
        initialValues={[{
          attribute_code: 'attr.amount',
          entered_value_num: 0,
          entered_unit_code: 'unit.g',
        }]}
        onResult={onResult}
      />,
    );

    fireEvent.change(screen.getByRole('textbox', { name: 'attr.amount' }), {
      target: { value: '1500' },
    });

    expect(onResult).toHaveBeenLastCalledWith(
      [{ attribute_code: 'attr.amount', entered_value_num: 1500, entered_unit_code: 'unit.g' }],
      [{
        attribute_code: 'attr.amount',
        value_num: 1.5,
        unit_code: 'unit.kg',
        entered_value_num: 1500,
        entered_unit_code: 'unit.g',
      }],
      true,
    );
  });

  it('preserves minimum, maximum, and parse validation reasons through EntryForm', () => {
    const onResult = vi.fn();
    render(
      <ControlledForm
        fieldStates={[state('attr.amount')]}
        initialValues={[{
          attribute_code: 'attr.amount',
          entered_value_num: 5,
          entered_unit_code: 'unit.kg',
        }]}
        onResult={onResult}
      />,
    );

    const input = screen.getByRole('textbox', { name: 'attr.amount' });
    fireEvent.change(input, { target: { value: '-1' } });
    expect(screen.getByRole('alert')).toHaveTextContent('capture.validation.minimum');
    expect(onResult.mock.lastCall?.[2]).toBe(false);

    fireEvent.change(input, { target: { value: '2001' } });
    expect(screen.getByRole('alert')).toHaveTextContent('capture.validation.maximum');

    fireEvent.change(input, { target: { value: 'broken' } });
    expect(screen.getByRole('alert')).toHaveTextContent('capture.validation.invalidNumber');
  });

  it('prunes an invalid-number key after its field is hidden and restored', () => {
    const onResult = vi.fn();
    const initialValues = [{
      attribute_code: 'attr.amount',
      entered_value_num: 5,
      entered_unit_code: 'unit.kg',
    }];
    const { rerender } = render(
      <ControlledForm
        fieldStates={[state('attr.amount')]}
        initialValues={initialValues}
        onResult={onResult}
      />,
    );

    fireEvent.change(screen.getByRole('textbox', { name: 'attr.amount' }), {
      target: { value: 'broken' },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('capture.validation.invalidNumber');

    rerender(
      <ControlledForm
        fieldStates={[state('attr.amount', { visible: false })]}
        initialValues={initialValues}
        onResult={onResult}
      />,
    );
    expect(screen.queryByRole('textbox', { name: 'attr.amount' })).not.toBeInTheDocument();

    rerender(
      <ControlledForm
        fieldStates={[state('attr.amount')]}
        initialValues={initialValues}
        onResult={onResult}
      />,
    );
    expect(screen.getByRole('textbox', { name: 'attr.amount' })).toHaveValue('5');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('prunes an invalid repeat-row key when the row is removed and re-added', () => {
    render(
      <ControlledForm
        fieldStates={[state('attr.amount_nutrient_rate')]}
        initialValues={[{
          attribute_code: 'attr.amount_nutrient_rate',
          group_index: 0,
          entered_value_num: 5,
          entered_unit_code: 'unit.kg_n_per_ha_nutrient',
        }]}
        onResult={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole('textbox', { name: 'capture.form.value' }), {
      target: { value: 'broken' },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('capture.validation.invalidNumber');

    fireEvent.click(screen.getByRole('button', { name: 'capture.form.remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.form.add' }));

    expect(screen.getByRole('textbox', { name: 'capture.form.value' })).toHaveValue('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('applies the Agroscope operation to device to unit cascade', () => {
    const onResult = vi.fn();
    render(
      <ControlledForm
        fieldStates={[
          state('attr.agroscope.operation'),
          state('attr.agroscope.device'),
          state('attr.amount_operation_depth'),
        ]}
        selections={{ activity_code: 'tillage_soil_work' }}
        onResult={onResult}
      />,
    );

    const operation = screen.getByRole('combobox', { name: 'Operation' });
    expect(within(operation).getByRole('option', { name: 'Primary tillage' })).toBeInTheDocument();
    fireEvent.change(operation, { target: { value: 'agroscope.operation.primary_tillage' } });

    const device = screen.getByRole('combobox', { name: 'Device' });
    expect(within(device).getByRole('option', { name: 'Plough' })).toBeInTheDocument();
    expect(within(device).queryByRole('option', { name: 'Harrow' })).not.toBeInTheDocument();
    fireEvent.change(device, { target: { value: 'agroscope.device.plough' } });

    expect(screen.getByText('cm')).toBeInTheDocument();
    expect(screen.queryByText('mm')).not.toBeInTheDocument();
  });

  it.each([
    ['unit.cross-basis', 'capture.validation.incompatibleUnit'],
    ['unit.wrong-kind', 'capture.validation.incompatibleUnit'],
  ])('shows a visible conversion error for %s', (unitCode, message) => {
    render(
      <ControlledForm
        fieldStates={[state('attr.amount')]}
        initialValues={[{
          attribute_code: 'attr.amount',
          entered_value_num: 2,
          entered_unit_code: unitCode,
        }]}
        showValidation
        onResult={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(message);
  });

  it('puts active products before rate fields and keeps composition derived-only', () => {
    const products = [
      {
        product_uuid: 'active-product',
        scope: 'farm',
        owner_user_uuid: 'user-1',
        gateway_device_eui: 'AABBCCDDEEFF0011',
        name: 'Active blend',
        kind: 'mineral',
        active: 1,
        sync_version: 0,
        created_at: timestamp,
        deleted_at: null,
        catalog_errors: [],
        composition: { N: 12 },
      },
      {
        product_uuid: 'inactive-product',
        scope: 'farm',
        owner_user_uuid: 'user-1',
        gateway_device_eui: 'AABBCCDDEEFF0011',
        name: 'Inactive blend',
        kind: 'mineral',
        active: 0,
        sync_version: 0,
        created_at: timestamp,
        deleted_at: null,
        catalog_errors: [],
        composition: { N: 99 },
      },
    ] satisfies JournalProductRow[];
    const onResult = vi.fn();
    render(
      <ControlledForm
        fieldStates={[state('attr.amount_nutrient_rate'), state('attr.product_uuid')]}
        products={products}
        initialValues={[{ attribute_code: 'attr.product_uuid', value: 'active-product' }]}
        onResult={onResult}
      />,
    );

    const productSelect = screen.getByRole('combobox', { name: 'capture.form.product' });
    expect(within(productSelect).getByRole('option', { name: 'Active blend' })).toBeInTheDocument();
    expect(within(productSelect).queryByRole('option', { name: 'Inactive blend' })).not.toBeInTheDocument();
    const nutrient = screen.getByText('attr.amount_nutrient_rate');
    expect(productSelect.compareDocumentPosition(nutrient) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('note')).toHaveTextContent('N');
    expect(screen.getByRole('note')).toHaveTextContent('12');
    expect(onResult).not.toHaveBeenCalled();
  });

  it('shows required validation when a visible repeatable nutrient field has no rows', () => {
    render(
      <ControlledForm
        fieldStates={[state('attr.amount_nutrient_rate', { required: true })]}
        showValidation
        onResult={vi.fn()}
      />,
    );

    const nutrientGroup = screen.getByRole('group', { name: /attr\.amount_nutrient_rate/ });
    const nutrientAlert = screen.getByRole('alert');
    expect(nutrientAlert).toHaveTextContent('capture.validation.required');
    expect(nutrientGroup).toHaveAttribute('aria-required', 'true');
    expect(nutrientGroup).toHaveAttribute('aria-describedby', nutrientAlert.id);
  });

  it('exposes required product, choice, and boolean errors to assistive technology', () => {
    const product = {
      product_uuid: 'required-product',
      scope: 'farm',
      owner_user_uuid: 'user-1',
      gateway_device_eui: 'AABBCCDDEEFF0011',
      name: 'Required blend',
      kind: 'mineral',
      active: 1,
      sync_version: 0,
      created_at: timestamp,
      deleted_at: null,
      catalog_errors: [],
      composition: {},
    } satisfies JournalProductRow;
    render(
      <ControlledForm
        fieldStates={[
          state('attr.product_uuid', { required: true }),
          state('attr.agroscope.operation', { required: true }),
          state('attr.flag', { required: true }),
          state('attr.text', { required: true }),
        ]}
        selections={{ activity_code: 'tillage_soil_work' }}
        products={[product]}
        showValidation
        onResult={vi.fn()}
      />,
    );

    const productSelect = screen.getByRole('combobox', { name: /capture\.form\.product/ });
    const choiceSelect = screen.getByRole('combobox', { name: /Operation/ });
    const booleanGroup = screen.getByRole('group', { name: /Boolean field/ });
    const textInput = screen.getByRole('textbox', { name: /Text field/ });

    expect(productSelect).toBeRequired();
    expect(choiceSelect).toBeRequired();
    expect(booleanGroup).toHaveAttribute('aria-required', 'true');
    expect(textInput).toBeRequired();
    expect(productSelect).toHaveAccessibleName(/capture\.form\.required/);
    expect(choiceSelect).toHaveAccessibleName(/capture\.form\.required/);
    expect(booleanGroup).toHaveAccessibleName(/capture\.form\.required/);
    expect(textInput).toHaveAccessibleName(/capture\.form\.required/);

    for (const control of [productSelect, choiceSelect, booleanGroup, textInput]) {
      const describedBy = control.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      expect(document.getElementById(describedBy!)).toHaveAttribute('role', 'alert');
      expect(document.getElementById(describedBy!)).toHaveTextContent(
        'capture.validation.required',
      );
    }
  });

  it('rejects a retained product UUID when that product is no longer active', () => {
    const inactiveProduct = {
      product_uuid: 'inactive-product',
      scope: 'farm',
      owner_user_uuid: 'user-1',
      gateway_device_eui: 'AABBCCDDEEFF0011',
      name: 'Inactive blend',
      kind: 'mineral',
      active: 0,
      sync_version: 0,
      created_at: timestamp,
      deleted_at: null,
      catalog_errors: [],
      composition: {},
    } satisfies JournalProductRow;
    const onResult = vi.fn();
    render(
      <ControlledForm
        fieldStates={[state('attr.product_uuid')]}
        products={[inactiveProduct]}
        initialValues={[{ attribute_code: 'attr.product_uuid', value: 'inactive-product' }]}
        showValidation
        onResult={onResult}
      />,
    );

    expect(screen.getByText('capture.form.noProducts')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('capture.validation.invalidDependency');
    const productSelect = screen.getByRole('combobox', { name: 'capture.form.product' });
    expect(productSelect).toHaveValue('inactive-product');

    fireEvent.change(productSelect, { target: { value: '' } });

    expect(onResult).toHaveBeenLastCalledWith(
      [{ attribute_code: 'attr.product_uuid', value: '' }],
      [],
      true,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('re-sorts active products when the locale changes', () => {
    const products = [
      {
        product_uuid: 'aker',
        scope: 'farm',
        owner_user_uuid: 'user-1',
        gateway_device_eui: 'AABBCCDDEEFF0011',
        name: 'Åker',
        kind: 'other',
        active: 1,
        sync_version: 0,
        created_at: timestamp,
        deleted_at: null,
        catalog_errors: [],
        composition: {},
      },
      {
        product_uuid: 'zebra',
        scope: 'farm',
        owner_user_uuid: 'user-1',
        gateway_device_eui: 'AABBCCDDEEFF0011',
        name: 'Zebra',
        kind: 'other',
        active: 1,
        sync_version: 0,
        created_at: timestamp,
        deleted_at: null,
        catalog_errors: [],
        composition: {},
      },
    ] satisfies JournalProductRow[];
    const productNames = () => within(
      screen.getByRole('combobox', { name: 'capture.form.product' }),
    ).getAllByRole('option').slice(1).map(({ textContent }) => textContent);
    const { rerender } = render(
      <ControlledForm
        fieldStates={[state('attr.product_uuid')]}
        products={products}
        locale="en-GB"
        onResult={vi.fn()}
      />,
    );
    expect(productNames()).toEqual(['Åker', 'Zebra']);

    rerender(
      <ControlledForm
        fieldStates={[state('attr.product_uuid')]}
        products={products}
        locale="sv-SE"
        onResult={vi.fn()}
      />,
    );
    expect(productNames()).toEqual(['Zebra', 'Åker']);
  });

  it('retains hidden inputs, omits them from payload, and treats zero and false as present', () => {
    const onResult = vi.fn();
    const hidden = { attribute_code: 'attr.text', value: 'retained' };
    render(
      <ControlledForm
        fieldStates={[
          state('attr.text', { visible: false, required: true }),
          state('attr.amount', { required: true }),
          state('attr.flag', { required: true }),
        ]}
        initialValues={[
          hidden,
          { attribute_code: 'attr.amount', entered_value_num: 0, entered_unit_code: 'unit.kg' },
        ]}
        showValidation
        onResult={onResult}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('capture.validation.required');
    fireEvent.click(screen.getByRole('button', { name: 'capture.form.booleanNo' }));

    const [inputs, payload, valid] = onResult.mock.lastCall as [
      CaptureEntryValueInput[],
      Array<Record<string, unknown>>,
      boolean,
    ];
    expect(inputs).toContainEqual(hidden);
    expect(payload).toEqual([
      {
        attribute_code: 'attr.amount',
        value_num: 0,
        unit_code: 'unit.kg',
        entered_value_num: 0,
        entered_unit_code: 'unit.kg',
      },
      { attribute_code: 'attr.flag', value: false },
    ]);
    expect(valid).toBe(true);
  });

  describe('Slice E: Full progressive disclosure (R5, E3)', () => {
    it('splits visible fields into an open "Key values" group and a collapsible "More detail" group', () => {
      render(
        <ControlledForm
          fieldStates={[
            state('attr.amount', { required: true }),
            state('attr.text'),
            state('attr.flag'),
          ]}
          templateCode="full_record"
          onResult={vi.fn()}
        />,
      );

      // The required field renders immediately, under the open "Key values" group.
      // (BUG 4: a required number field now also carries the Required badge
      // in its accessible name, so this is a substring match rather than an
      // exact one -- see the dedicated Required-badge tests below.)
      expect(screen.getByText('capture.form.keyValues')).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: /^attr\.amount/ })).toBeInTheDocument();

      // The optional fields start tucked behind the closed "More detail" disclosure.
      const toggle = screen.getByRole('button', { name: 'capture.form.moreDetail' });
      expect(toggle).not.toBeNull();
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByRole('textbox', { name: 'Text field' })).not.toBeInTheDocument();
      expect(screen.queryByRole('group', { name: 'Boolean field' })).not.toBeInTheDocument();

      fireEvent.click(toggle!);

      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('textbox', { name: 'Text field' })).toBeInTheDocument();
      expect(screen.getByRole('group', { name: 'Boolean field' })).toBeInTheDocument();
    });

    it('never hides a required_any field inside the collapsed group while it is empty', () => {
      render(
        <ControlledForm
          fieldStates={[
            state('attr.text', { required_any_groups: [0] }),
            state('attr.flag', { required_any_groups: [0] }),
          ]}
          templateCode="full_record"
          onResult={vi.fn()}
        />,
      );

      // Both required_any members are effectively-required until one of them
      // has a value, so neither may ever be hidden behind the collapsed
      // disclosure — there is nothing left to put in "More detail" at all.
      // (POLISH 6: a required_any member's badge now reads "choose one"
      // rather than "Optional" and is exposed in the accessible name just
      // like a plain required field's badge already was, so this is a
      // substring match — see the dedicated required_any badge test.)
      expect(screen.getByRole('textbox', { name: /^Text field/ })).toBeInTheDocument();
      expect(screen.getByRole('group', { name: /^Boolean field/ })).toBeInTheDocument();
      expect(screen.queryByText('capture.form.moreDetail')).not.toBeInTheDocument();
    });

    it('does not group fields when templateCode is absent or not full_record (Quick/research unaffected)', () => {
      render(
        <ControlledForm
          fieldStates={[
            state('attr.amount', { required: true }),
            state('attr.text'),
          ]}
          onResult={vi.fn()}
        />,
      );

      expect(screen.queryByText('capture.form.keyValues')).not.toBeInTheDocument();
      expect(screen.queryByText('capture.form.moreDetail')).not.toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: /^attr\.amount/ })).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Text field' })).toBeInTheDocument();
    });

    it('Fix 2: keeps activity-dependency choice fields (operation, device) in the open "Key values" group even when optional', () => {
      render(
        <ControlledForm
          fieldStates={[
            state('attr.agroscope.operation'),
            state('attr.agroscope.device'),
            state('attr.text'),
            state('attr.amount_operation_depth'),
          ]}
          templateCode="full_record"
          onResult={vi.fn()}
        />,
      );

      // attr.agroscope.operation and attr.agroscope.device are choice
      // targets of this layout's option_dependencies (operation restricted
      // by activity_code, device restricted in turn by operation) -- the
      // chosen operation/device are the primary thing to confirm, so they
      // must render immediately under "Key values", never behind the
      // collapsed "More detail" disclosure, even though neither carries
      // required: true here.
      expect(screen.getByText('capture.form.keyValues')).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: 'Operation' })).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: 'Device' })).toBeInTheDocument();

      // A plain optional field that is not an activity-dependency target
      // still starts tucked behind the collapsed disclosure.
      expect(screen.queryByRole('textbox', { name: 'Text field' })).not.toBeInTheDocument();

      // A UNIT-only restriction target must NOT be promoted: attr.amount_operation_depth
      // is restricted by this layout only in its allowed *units* (device plough ->
      // unit.cm_operation_depth), which narrows a unit choice rather than being a
      // "pick" the farmer confirms. Only `choices` restriction targets are key fields,
      // so it stays behind "More detail" like any other optional field.
      expect(screen.queryByText('attr.amount_operation_depth')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'capture.form.moreDetail' }));
      expect(screen.getByRole('textbox', { name: 'Text field' })).toBeInTheDocument();
      expect(screen.getByText('attr.amount_operation_depth')).toBeInTheDocument();
    });
  });
});
