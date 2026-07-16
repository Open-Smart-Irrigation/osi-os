import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { JournalProductRow } from '../../../types/journal';
import type { CaptureEntryValueInput } from '../../../types/journalCapture';
import { NumberStepper } from './NumberStepper';

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--card)]';

export interface NutrientUnitOption {
  code: string;
  label: string;
}

export interface NutrientRepeaterProps {
  attributeCode: string;
  label: string;
  locale?: string;
  values: CaptureEntryValueInput[];
  units: NutrientUnitOption[];
  onChange: (values: CaptureEntryValueInput[]) => void;
  onValidityChange?: (groupIndex: number, valid: boolean, error?: string) => void;
  product?: JournalProductRow | null;
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
  error?: string | null;
  errors?: Record<number, string | null | undefined>;
}

function editableRow(
  row: CaptureEntryValueInput,
  changes: Pick<CaptureEntryValueInput, 'entered_value_num' | 'entered_unit_code'>,
): CaptureEntryValueInput {
  return {
    attribute_code: row.attribute_code,
    ...(row.group_index == null ? {} : { group_index: row.group_index }),
    ...(row.value_status == null ? {} : { value_status: row.value_status }),
    ...changes,
  };
}

function compositionFacts(product: JournalProductRow | null | undefined): Array<[string, string]> {
  if (!product?.composition) return [];
  return Object.entries(product.composition)
    .filter((entry): entry is [string, string | number | boolean] =>
      ['string', 'number', 'boolean'].includes(typeof entry[1]))
    .map(([key, value]): [string, string] => [key, String(value)])
    .sort(([left], [right]) => left.localeCompare(right));
}

function validGroupIndex(value: number | undefined): value is number {
  return Number.isInteger(value) && value != null && value >= 0;
}

export function normalizeNutrientRows(
  values: CaptureEntryValueInput[],
): CaptureEntryValueInput[] {
  const reserved = new Set(
    values.map(({ group_index: groupIndex }) => groupIndex).filter(validGroupIndex),
  );
  const claimed = new Set<number>();
  let fallback = 0;
  return values.map((row) => {
    if (validGroupIndex(row.group_index) && !claimed.has(row.group_index)) {
      claimed.add(row.group_index);
      return row;
    }
    while (reserved.has(fallback) || claimed.has(fallback)) fallback += 1;
    const groupIndex = fallback;
    reserved.add(groupIndex);
    claimed.add(groupIndex);
    fallback += 1;
    return { ...row, group_index: groupIndex };
  });
}

export const NutrientRepeater: React.FC<NutrientRepeaterProps> = ({
  attributeCode,
  label,
  locale,
  values,
  units,
  onChange,
  onValidityChange,
  product,
  min,
  max,
  step,
  required = false,
  error,
  errors = {},
}) => {
  const { t } = useTranslation('journal');
  const facts = compositionFacts(product);
  const errorId = `${attributeCode}-error`;
  const normalizedValues = useMemo(() => normalizeNutrientRows(values), [values]);
  const nextGroupIndex = normalizedValues.reduce(
    (highest, row) => Math.max(highest, row.group_index ?? 0),
    -1,
  ) + 1;

  return (
    <fieldset
      aria-required={required}
      aria-invalid={Boolean(error)}
      aria-describedby={error ? errorId : undefined}
      className="space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4"
    >
      <legend className="px-1 text-sm font-bold text-[var(--text)]">{label}</legend>

      {facts.length > 0 && (
        <aside
          role="note"
          className="rounded-xl bg-[var(--secondary-bg)] px-3 py-2 text-sm text-[var(--text-secondary)]"
        >
          <p className="font-bold text-[var(--text)]">{t('capture.form.derivedNutrients')}</p>
          <dl className="mt-1 flex flex-wrap gap-2">
            {facts.map(([key, value]) => (
              <div key={key} className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1">
                <dt className="inline font-bold">{key}</dt>
                <dd className="ml-1 inline tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </aside>
      )}

      <div className="space-y-3">
        {normalizedValues.map((row, index) => {
          const groupIndex = row.group_index ?? index;
          return (
            <div
              key={groupIndex}
              className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3"
            >
              <div className="flex flex-wrap gap-2" role="group" aria-label={t('capture.form.unit')}>
                {units.map((unit) => {
                  const selected = row.entered_unit_code === unit.code;
                  return (
                    <button
                      key={unit.code}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => onChange(normalizedValues.map((value, valueIndex) =>
                        valueIndex === index
                          ? editableRow(value, {
                              entered_value_num: value.entered_value_num ?? value.value_num ?? null,
                              entered_unit_code: unit.code,
                            })
                          : value))}
                      className={`min-h-11 rounded-full border px-3 py-2 text-sm font-bold transition-colors ${
                        selected
                          ? 'border-[var(--primary)] bg-[var(--primary)] text-white'
                          : 'border-[var(--border)] bg-[var(--card)] text-[var(--text)] hover:border-[var(--focus)]'
                      } ${FOCUS_RING}`}
                    >
                      {unit.label}
                    </button>
                  );
                })}
              </div>

              <NumberStepper
                id={`${attributeCode}-${groupIndex}`}
                label={t('capture.form.value')}
                locale={locale}
                value={row.entered_value_num ?? row.value_num ?? null}
                min={min}
                max={max}
                step={step}
                error={errors[groupIndex]}
                onValidityChange={(valid, validationError) =>
                  onValidityChange?.(groupIndex, valid, validationError)}
                onChange={(enteredValue) => onChange(normalizedValues.map((value, valueIndex) =>
                  valueIndex === index
                    ? editableRow(value, {
                        entered_value_num: enteredValue,
                        entered_unit_code: value.entered_unit_code ?? value.unit_code ?? null,
                      })
                    : value))}
              />

              <button
                type="button"
                aria-label={t('capture.form.remove')}
                onClick={() => onChange(
                  normalizedValues.filter((_, valueIndex) => valueIndex !== index),
                )}
                className={`min-h-11 rounded-lg px-3 py-2 text-sm font-bold text-[var(--error-text)] transition-colors hover:bg-[var(--error-bg)] ${FOCUS_RING}`}
              >
                {t('capture.form.remove')}
              </button>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        aria-label={t('capture.form.add')}
        onClick={() => onChange([...normalizedValues, {
          attribute_code: attributeCode,
          group_index: nextGroupIndex,
          entered_value_num: null,
          entered_unit_code: null,
        }])}
        className={`min-h-11 w-full rounded-xl border border-dashed border-[var(--primary)] px-4 py-2 text-sm font-bold text-[var(--primary)] transition-colors hover:bg-[var(--secondary-bg)] ${FOCUS_RING}`}
      >
        {t('capture.form.add')}
      </button>
      {error && (
        <p
          id={errorId}
          role="alert"
          className="text-sm font-semibold text-[var(--error-text)]"
        >
          {error}
        </p>
      )}
    </fieldset>
  );
};
