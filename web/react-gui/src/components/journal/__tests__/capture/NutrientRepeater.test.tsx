import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { JournalProductRow } from '../../../../types/journal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { resolvedLanguage: 'en-GB', language: 'en-GB' },
  }),
}));

import { NutrientRepeater } from '../../capture/NutrientRepeater';

const units = [
  { code: 'unit.kg_n_per_ha_nutrient', label: 'kg N/ha' },
  { code: 'unit.kg_p2o5_per_ha_nutrient', label: 'kg P₂O₅/ha' },
];

const product = {
  product_uuid: 'product-1',
  scope: 'farm',
  owner_user_uuid: 'user-1',
  gateway_device_eui: 'AABBCCDDEEFF0011',
  name: 'Farm blend',
  kind: 'mineral',
  active: 1,
  sync_version: 0,
  created_at: '2026-07-16T00:00:00.000Z',
  deleted_at: null,
  catalog_errors: [],
  composition: { N: 12, P2O5: 6 },
} satisfies JournalProductRow;

describe('NutrientRepeater', () => {
  it('preserves explicit group indices and uses fixed nutrient-unit chips', () => {
    const onChange = vi.fn();
    render(
      <NutrientRepeater
        attributeCode="attr.amount_nutrient_rate"
        label="Nutrient rate"
        locale="en-GB"
        units={units}
        values={[{
          attribute_code: 'attr.amount_nutrient_rate',
          group_index: 3,
          entered_value_num: 20,
          entered_unit_code: 'unit.kg_n_per_ha_nutrient',
        }]}
        onChange={onChange}
      />,
    );

    expect(screen.getByRole('button', { name: 'kg N/ha' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'kg P₂O₅/ha' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'kg N/ha' })).toHaveClass('min-h-11');

    fireEvent.click(screen.getByRole('button', { name: 'kg P₂O₅/ha' }));

    expect(onChange).toHaveBeenLastCalledWith([{
      attribute_code: 'attr.amount_nutrient_rate',
      group_index: 3,
      entered_value_num: 20,
      entered_unit_code: 'unit.kg_p2o5_per_ha_nutrient',
    }]);
  });

  it('adds and removes rows without renumbering surviving group indices', () => {
    const onChange = vi.fn();
    const values = [
      {
        attribute_code: 'attr.amount_nutrient_rate',
        group_index: 2,
        entered_value_num: 5,
        entered_unit_code: 'unit.kg_n_per_ha_nutrient',
      },
      {
        attribute_code: 'attr.amount_nutrient_rate',
        group_index: 7,
        entered_value_num: 8,
        entered_unit_code: 'unit.kg_p2o5_per_ha_nutrient',
      },
    ];
    render(
      <NutrientRepeater
        attributeCode="attr.amount_nutrient_rate"
        label="Nutrient rate"
        locale="en-GB"
        units={units}
        values={values}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'capture.form.add' }));
    expect(onChange).toHaveBeenLastCalledWith([
      ...values,
      {
        attribute_code: 'attr.amount_nutrient_rate',
        group_index: 8,
        entered_value_num: null,
        entered_unit_code: null,
      },
    ]);

    fireEvent.click(screen.getAllByRole('button', { name: 'capture.form.remove' })[0]);
    expect(onChange).toHaveBeenLastCalledWith([values[1]]);
  });

  it('shows product composition as display-only facts and never stores derived rows', () => {
    const onChange = vi.fn();
    render(
      <NutrientRepeater
        attributeCode="attr.amount_nutrient_rate"
        label="Nutrient rate"
        locale="en-GB"
        units={units}
        values={[]}
        product={product}
        onChange={onChange}
      />,
    );

    const derived = screen.getByRole('note');
    expect(derived).toHaveTextContent('capture.form.derivedNutrients');
    expect(derived).toHaveTextContent('N');
    expect(derived).toHaveTextContent('12');
    expect(derived).toHaveTextContent('P2O5');
    expect(derived).toHaveTextContent('6');

    fireEvent.click(screen.getByRole('button', { name: 'capture.form.add' }));
    expect(onChange).toHaveBeenLastCalledWith([{
      attribute_code: 'attr.amount_nutrient_rate',
      group_index: 0,
      entered_value_num: null,
      entered_unit_code: null,
    }]);
  });

  it('normalizes missing group indices before rendering and allocating another row', () => {
    const onChange = vi.fn();
    const values = [
      {
        attribute_code: 'attr.amount_nutrient_rate',
        entered_value_num: 4,
        entered_unit_code: 'unit.kg_n_per_ha_nutrient',
      },
      {
        attribute_code: 'attr.amount_nutrient_rate',
        entered_value_num: 6,
        entered_unit_code: 'unit.kg_p2o5_per_ha_nutrient',
      },
    ];
    render(
      <NutrientRepeater
        attributeCode="attr.amount_nutrient_rate"
        label="Nutrient rate"
        locale="en-GB"
        units={units}
        values={values}
        errors={{ 0: 'first error', 1: 'second error' }}
        onChange={onChange}
      />,
    );

    const inputs = screen.getAllByRole('textbox', { name: 'capture.form.value' });
    expect(inputs.map(({ id }) => id)).toEqual([
      'attr.amount_nutrient_rate-0',
      'attr.amount_nutrient_rate-1',
    ]);
    expect(inputs[0]).toHaveAttribute('aria-describedby', 'attr.amount_nutrient_rate-0-error');
    expect(inputs[1]).toHaveAttribute('aria-describedby', 'attr.amount_nutrient_rate-1-error');

    fireEvent.click(screen.getByRole('button', { name: 'capture.form.add' }));
    expect(onChange).toHaveBeenLastCalledWith([
      { ...values[0], group_index: 0 },
      { ...values[1], group_index: 1 },
      {
        attribute_code: 'attr.amount_nutrient_rate',
        group_index: 2,
        entered_value_num: null,
        entered_unit_code: null,
      },
    ]);
  });
});
