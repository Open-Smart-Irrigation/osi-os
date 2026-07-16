import React, { useEffect, useMemo, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import {
  allowedChoices,
  allowedUnits,
  catalogLabel,
  convertNumericValue,
} from '../../../journal/catalogModel';
import { buildEntryValues } from '../../../journal/templateEngine';
import type { JournalProductRow, JournalVocabRow } from '../../../types/journal';
import type {
  CaptureEntryValueInput,
  CaptureEntryValueOutput,
  JournalCaptureCatalogModel,
  JournalFieldState,
  JournalLayoutDefinition,
  JournalScalar,
  JournalSelections,
} from '../../../types/journalCapture';
import { normalizeNutrientRows, NutrientRepeater } from './NutrientRepeater';
import { NumberStepper } from './NumberStepper';

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--card)]';

type Translate = TFunction<'journal'>;

export interface EntryFormProps {
  model: JournalCaptureCatalogModel;
  layout: JournalLayoutDefinition;
  fieldStates: JournalFieldState[];
  values: CaptureEntryValueInput[];
  onChange: (
    inputs: CaptureEntryValueInput[],
    payload: CaptureEntryValueOutput[],
    valid: boolean,
  ) => void;
  selections?: JournalSelections;
  products?: JournalProductRow[];
  locale?: string;
  showValidation?: boolean;
}

interface ValidationResult {
  valid: boolean;
  payload: CaptureEntryValueOutput[];
  errors: Map<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function numericConstraints(attribute: JournalVocabRow): {
  min?: number;
  max?: number;
  step?: number;
  repeatable: boolean;
} {
  if (!isRecord(attribute.constraints)) return { repeatable: false };
  return {
    ...(typeof attribute.constraints.min === 'number' ? { min: attribute.constraints.min } : {}),
    ...(typeof attribute.constraints.max === 'number' ? { max: attribute.constraints.max } : {}),
    ...(typeof attribute.constraints.step === 'number' ? { step: attribute.constraints.step } : {}),
    repeatable: attribute.constraints.repeatable === true,
  };
}

function semanticValue(input: CaptureEntryValueInput | undefined): JournalScalar | undefined {
  if (!input) return undefined;
  if (input.value !== undefined) return input.value;
  if (input.value_text != null) return input.value_text;
  if (input.entered_value_num != null) return input.entered_value_num;
  if (input.value_num != null) return input.value_num;
  return undefined;
}

function hasInputValue(input: CaptureEntryValueInput | undefined): boolean {
  if (!input) return false;
  if (input.value_status != null && input.value_status !== 'observed') return true;
  const value = semanticValue(input);
  return value !== undefined && value !== null && value !== '';
}

function fieldValues(values: CaptureEntryValueInput[], code: string): CaptureEntryValueInput[] {
  return values.filter(({ attribute_code }) => attribute_code === code);
}

function replaceFieldValues(
  values: CaptureEntryValueInput[],
  code: string,
  replacements: CaptureEntryValueInput[],
): CaptureEntryValueInput[] {
  const first = values.findIndex(({ attribute_code }) => attribute_code === code);
  const without = values.filter(({ attribute_code }) => attribute_code !== code);
  if (first < 0) return [...values, ...replacements];
  const insertion = values.slice(0, first)
    .filter(({ attribute_code }) => attribute_code !== code).length;
  return [...without.slice(0, insertion), ...replacements, ...without.slice(insertion)];
}

function semanticInput(
  code: string,
  value: JournalScalar,
  previous?: CaptureEntryValueInput,
): CaptureEntryValueInput {
  return {
    attribute_code: code,
    ...(previous?.group_index == null ? {} : { group_index: previous.group_index }),
    ...(previous?.value_status == null ? {} : { value_status: previous.value_status }),
    value,
  };
}

function numericInput(
  code: string,
  enteredValue: number | null,
  enteredUnit: string | null,
  previous?: CaptureEntryValueInput,
): CaptureEntryValueInput {
  return {
    attribute_code: code,
    ...(previous?.group_index == null ? {} : { group_index: previous.group_index }),
    ...(previous?.value_status == null ? {} : { value_status: previous.value_status }),
    entered_value_num: enteredValue,
    entered_unit_code: enteredUnit,
  };
}

function mergedSelections(
  base: JournalSelections,
  values: CaptureEntryValueInput[],
): JournalSelections {
  const merged: JournalSelections = { ...base };
  const grouped = new Map<string, JournalScalar[]>();
  for (const input of values) {
    const value = semanticValue(input);
    if (value === undefined) continue;
    const selected = grouped.get(input.attribute_code) ?? [];
    selected.push(value);
    grouped.set(input.attribute_code, selected);
  }
  for (const [code, selected] of grouped) {
    merged[code] = selected.length === 1 ? selected[0] : selected;
  }
  return merged;
}

function conversionMessage(code: string, t: Translate): string {
  if (code === 'invalid_number') return t('capture.validation.invalidNumber');
  if (code === 'cross_basis_forbidden' || code === 'unit_incompatible' ||
      code === 'unknown_unit' || code === 'inactive_unit') {
    return t('capture.validation.incompatibleUnit');
  }
  return t('capture.validation.invalidDefinition');
}

function visibleAttributeStates(
  model: JournalCaptureCatalogModel,
  states: JournalFieldState[],
): JournalFieldState[] {
  return states.filter((state) =>
    state.visible && model.vocabByCode.get(state.code)?.kind === 'attribute');
}

function validNumberErrorKeys(
  model: JournalCaptureCatalogModel,
  states: JournalFieldState[],
  inputs: CaptureEntryValueInput[],
): Set<string> {
  const keys = new Set<string>();
  for (const state of visibleAttributeStates(model, states)) {
    const attribute = model.vocabByCode.get(state.code);
    if (attribute?.value_type !== 'number') continue;
    if (!numericConstraints(attribute).repeatable) {
      keys.add(state.code);
      continue;
    }
    for (const [index, row] of normalizeNutrientRows(fieldValues(inputs, state.code)).entries()) {
      keys.add(`${state.code}:${row.group_index ?? index}`);
    }
  }
  return keys;
}

function pruneNumberErrors(
  errors: ReadonlyMap<string, string>,
  model: JournalCaptureCatalogModel,
  states: JournalFieldState[],
  inputs: CaptureEntryValueInput[],
): Map<string, string> {
  const validKeys = validNumberErrorKeys(model, states, inputs);
  return new Map([...errors].filter(([key]) => validKeys.has(key)));
}

function sameErrors(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  return left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);
}

function validateForm(
  model: JournalCaptureCatalogModel,
  layout: JournalLayoutDefinition,
  states: JournalFieldState[],
  inputs: CaptureEntryValueInput[],
  selections: JournalSelections,
  numberInputErrors: ReadonlyMap<string, string>,
  products: JournalProductRow[],
  t: Translate,
): ValidationResult {
  const visibleStates = visibleAttributeStates(model, states);
  const visibleCodes = new Set(visibleStates.map(({ code }) => code));
  const visibleInputs = inputs.filter(({ attribute_code }) => visibleCodes.has(attribute_code));
  const currentSelections = mergedSelections(selections, inputs);
  const errors = new Map<string, string>();

  for (const state of visibleStates) {
    const attribute = model.vocabByCode.get(state.code);
    if (!attribute) continue;
    const rows = fieldValues(inputs, state.code);
    if (state.required && !rows.some(hasInputValue)) {
      errors.set(state.code, t('capture.validation.required'));
    }
    if (state.code === 'attr.product_uuid') {
      const selected = semanticValue(rows[0]);
      if (typeof selected === 'string' && selected !== '' && !products.some((product) =>
        product.product_uuid === selected && product.active === 1 && product.deleted_at == null)) {
        errors.set(state.code, t('capture.validation.invalidDependency'));
      }
    }
    if (attribute.value_type === 'choice') {
      const choices = allowedChoices(model, layout, state.code, currentSelections);
      const dependencyTarget = layout.option_dependencies.some(
        ({ restrict }) => restrict.attribute_code === state.code,
      );
      for (const row of rows) {
        const selected = semanticValue(row);
        if (typeof selected === 'string' &&
            (dependencyTarget || choices.length > 0) && !choices.includes(selected)) {
          errors.set(state.code, t('capture.validation.invalidDependency'));
        }
      }
    }
    if (attribute.value_type !== 'number') continue;
    const constraints = numericConstraints(attribute);
    const units = allowedUnits(model, layout, state.code, currentSelections);
    const dependencyTarget = layout.option_dependencies.some(
      ({ restrict }) => restrict.attribute_code === state.code,
    );
    const numericRows = constraints.repeatable ? normalizeNutrientRows(rows) : rows;
    for (const [index, row] of numericRows.entries()) {
      const groupIndex = row.group_index ?? index;
      const key = `${state.code}:${groupIndex}`;
      const inputError = numberInputErrors.get(key) ?? numberInputErrors.get(state.code);
      if (inputError) {
        errors.set(key, inputError);
        continue;
      }
      const enteredValue = row.entered_value_num ?? row.value_num ??
        (typeof row.value === 'number' ? row.value : null);
      const enteredUnit = row.entered_unit_code ?? row.unit_code;
      if (enteredValue == null && enteredUnit == null) continue;
      if (enteredValue == null || enteredUnit == null) {
        errors.set(key, t('capture.validation.incompatibleUnit'));
        continue;
      }
      if (constraints.min != null && enteredValue < constraints.min) {
        errors.set(key, t('capture.validation.minimum', { min: constraints.min }));
        continue;
      }
      if (constraints.max != null && enteredValue > constraints.max) {
        errors.set(key, t('capture.validation.maximum', { max: constraints.max }));
        continue;
      }
      const conversion = convertNumericValue(model, state.code, enteredValue, enteredUnit);
      if ('ok' in conversion) {
        errors.set(key, conversionMessage(conversion.code, t));
        continue;
      }
      if ((dependencyTarget || units.length > 0) && !units.includes(enteredUnit)) {
        errors.set(key, t('capture.validation.invalidDependency'));
      }
    }
  }

  const requiredAnyGroups = new Map<number, JournalFieldState[]>();
  for (const state of visibleStates) {
    for (const group of state.required_any_groups) {
      const members = requiredAnyGroups.get(group) ?? [];
      members.push(state);
      requiredAnyGroups.set(group, members);
    }
  }
  for (const members of requiredAnyGroups.values()) {
    if (members.some(({ code }) => fieldValues(inputs, code).some(hasInputValue))) continue;
    for (const member of members) {
      if (!errors.has(member.code)) errors.set(member.code, t('capture.validation.required'));
    }
  }

  let payload: CaptureEntryValueOutput[] = [];
  try {
    payload = buildEntryValues(model, visibleInputs);
  } catch {
    // Specific conversion/dependency errors above remain the user-visible source.
    if (errors.size === 0) errors.set('form', t('capture.validation.invalidDefinition'));
  }
  return { valid: errors.size === 0, payload, errors };
}

function productFirst(states: JournalFieldState[]): JournalFieldState[] {
  return states
    .map((state, index) => ({ state, index }))
    .sort((left, right) => {
      const leftProduct = left.state.code === 'attr.product_uuid' ? 0 : 1;
      const rightProduct = right.state.code === 'attr.product_uuid' ? 0 : 1;
      return leftProduct - rightProduct || left.index - right.index;
    })
    .map(({ state }) => state);
}

export const EntryForm: React.FC<EntryFormProps> = ({
  model,
  layout,
  fieldStates,
  values,
  onChange,
  selections = {},
  products = [],
  locale: localeOverride,
  showValidation = false,
}) => {
  const { t, i18n } = useTranslation('journal');
  const locale = localeOverride || i18n.resolvedLanguage || i18n.language;
  const [numberInputErrors, setNumberInputErrors] = useState<Map<string, string>>(
    () => new Map(),
  );
  const currentSelections = useMemo(
    () => mergedSelections(selections, values),
    [selections, values],
  );
  const visibleStates = useMemo(
    () => productFirst(visibleAttributeStates(model, fieldStates)),
    [fieldStates, model],
  );
  const validation = validateForm(
    model,
    layout,
    fieldStates,
    values,
    selections,
    numberInputErrors,
    products,
    t,
  );
  const activeProducts = useMemo(
    () => products
      .filter(({ active, deleted_at: deletedAt }) => active === 1 && deletedAt == null)
      .sort((left, right) => left.name.localeCompare(right.name, locale)),
    [locale, products],
  );
  const selectedProductUuid = semanticValue(fieldValues(values, 'attr.product_uuid')[0]);
  const selectedProduct = typeof selectedProductUuid === 'string'
    ? activeProducts.find(({ product_uuid: uuid }) => uuid === selectedProductUuid)
    : undefined;

  useEffect(() => {
    setNumberInputErrors((current) => {
      const pruned = pruneNumberErrors(current, model, fieldStates, values);
      return sameErrors(current, pruned) ? current : pruned;
    });
  }, [fieldStates, model, values]);

  const emit = (
    next: CaptureEntryValueInput[],
    inputErrors: ReadonlyMap<string, string> = numberInputErrors,
  ) => {
    const prunedErrors = pruneNumberErrors(inputErrors, model, fieldStates, next);
    if (!sameErrors(numberInputErrors, prunedErrors)) setNumberInputErrors(prunedErrors);
    const result = validateForm(
      model,
      layout,
      fieldStates,
      next,
      selections,
      prunedErrors,
      products,
      t,
    );
    onChange(next, result.payload, result.valid);
  };

  const updateSingle = (code: string, next: CaptureEntryValueInput) => {
    emit(replaceFieldValues(values, code, [next]));
  };

  const errorFor = (code: string, groupIndex?: number): string | undefined => {
    const specific = groupIndex == null ? undefined : validation.errors.get(`${code}:${groupIndex}`);
    const error = specific ?? validation.errors.get(code);
    if (!error) return undefined;
    const required = error === t('capture.validation.required');
    return !required || showValidation ? error : undefined;
  };

  return (
    <div className="space-y-4">
      {visibleStates.map((state) => {
        const attribute = model.vocabByCode.get(state.code);
        if (!attribute) return null;
        const rows = fieldValues(values, state.code);
        const existing = rows[0];
        const label = catalogLabel(attribute, locale);
        const statusLabel = state.required ? t('capture.form.required') : t('capture.form.optional');
        const fieldError = errorFor(state.code);
        const fieldErrorId = `${state.code}-error`;

        if (state.code === 'attr.product_uuid') {
          const retainedProduct = typeof selectedProductUuid === 'string' &&
            !activeProducts.some(({ product_uuid: uuid }) => uuid === selectedProductUuid)
            ? products.find(({ product_uuid: uuid }) => uuid === selectedProductUuid)
            : undefined;
          return (
            <div key={state.code} className="space-y-2">
              <label htmlFor={state.code} className="flex items-center justify-between gap-3 text-sm font-bold text-[var(--text)]">
                <span>{t('capture.form.product')}</span>
                <span
                  aria-hidden={state.required ? undefined : true}
                  className="text-xs font-semibold text-[var(--text-secondary)]"
                >
                  {statusLabel}
                </span>
              </label>
              {activeProducts.length === 0 && (
                <p className="rounded-xl bg-[var(--secondary-bg)] px-3 py-2 text-sm text-[var(--text-secondary)]">
                  {t('capture.form.noProducts')}
                </p>
              )}
              <select
                id={state.code}
                required={state.required}
                aria-invalid={Boolean(fieldError)}
                aria-describedby={fieldError ? fieldErrorId : undefined}
                value={typeof semanticValue(existing) === 'string' ? String(semanticValue(existing)) : ''}
                onChange={(event) => updateSingle(
                  state.code,
                  semanticInput(state.code, event.target.value, existing),
                )}
                className={`min-h-12 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--text)] ${FOCUS_RING}`}
              >
                <option value="">{t('capture.form.select')}</option>
                {typeof selectedProductUuid === 'string' && selectedProductUuid !== '' &&
                  !activeProducts.some(({ product_uuid: uuid }) => uuid === selectedProductUuid) && (
                    <option value={selectedProductUuid} disabled>
                      {retainedProduct?.name ?? t('capture.validation.invalidDependency')}
                    </option>
                  )}
                {activeProducts.map((product) => (
                  <option key={product.product_uuid} value={product.product_uuid}>{product.name}</option>
                ))}
              </select>
              {fieldError && (
                <p
                  id={fieldErrorId}
                  role="alert"
                  className="text-sm font-semibold text-[var(--error-text)]"
                >
                  {fieldError}
                </p>
              )}
            </div>
          );
        }

        if (attribute.value_type === 'number') {
          const constraints = numericConstraints(attribute);
          const unitCodes = allowedUnits(model, layout, state.code, currentSelections);
          const unitOptions = unitCodes.map((code) => ({
            code,
            label: catalogLabel(model.vocabByCode.get(code)!, locale),
          }));
          if (constraints.repeatable) {
            const normalizedRows = normalizeNutrientRows(rows);
            const repeatErrors = Object.fromEntries(normalizedRows.map((row, index) => {
              const groupIndex = row.group_index ?? index;
              return [groupIndex, errorFor(state.code, groupIndex)];
            }));
            return (
              <NutrientRepeater
                key={state.code}
                attributeCode={state.code}
                label={label}
                locale={locale}
                values={normalizedRows}
                units={unitOptions}
                product={selectedProduct}
                min={constraints.min}
                max={constraints.max}
                step={constraints.step}
                required={state.required}
                error={errorFor(state.code)}
                errors={repeatErrors}
                onValidityChange={(groupIndex, valid, validationError) => {
                  const nextErrors = new Map(numberInputErrors);
                  const key = `${state.code}:${groupIndex}`;
                  if (valid) nextErrors.delete(key);
                  else nextErrors.set(
                    key,
                    validationError ?? t('capture.validation.invalidNumber'),
                  );
                  setNumberInputErrors(nextErrors);
                  emit(values, nextErrors);
                }}
                onChange={(nextRows) => emit(replaceFieldValues(values, state.code, nextRows))}
              />
            );
          }

          const enteredValue = existing?.entered_value_num ?? existing?.value_num ??
            (typeof existing?.value === 'number' ? existing.value : null);
          const currentUnit = existing?.entered_unit_code ?? existing?.unit_code;
          const selectedUnit = currentUnit ??
            (attribute.default_unit_code && unitCodes.includes(attribute.default_unit_code)
              ? attribute.default_unit_code
              : unitCodes.length === 1 ? unitCodes[0] : null);
          const selectedUnitLabel = unitOptions.find(({ code }) => code === selectedUnit)?.label;
          const numberError = errorFor(state.code, existing?.group_index ?? 0);
          const control = (
            <NumberStepper
              id={state.code}
              label={label}
              locale={locale}
              value={enteredValue}
              min={constraints.min}
              max={constraints.max}
              step={constraints.step}
              required={state.required}
              unitLabel={unitCodes.length === 1 ? selectedUnitLabel : undefined}
              error={numberError}
              onValidityChange={(valid, validationError) => {
                const nextErrors = new Map(numberInputErrors);
                if (valid) nextErrors.delete(state.code);
                else nextErrors.set(
                  state.code,
                  validationError ?? t('capture.validation.invalidNumber'),
                );
                setNumberInputErrors(nextErrors);
                emit(values, nextErrors);
              }}
              onChange={(entered) => updateSingle(
                state.code,
                numericInput(state.code, entered, selectedUnit, existing),
              )}
            />
          );

          if (unitCodes.length === 2) {
            return (
              <div key={state.code} className="space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4">
                {control}
                <div role="group" aria-label={t('capture.form.unit')} className="inline-flex w-full overflow-hidden rounded-xl border border-[var(--border)]">
                  {unitOptions.map((unit) => {
                    const selected = unit.code === selectedUnit;
                    return (
                      <button
                        key={unit.code}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => updateSingle(
                          state.code,
                          numericInput(state.code, enteredValue, unit.code, existing),
                        )}
                        className={`min-h-11 flex-1 px-3 py-2 text-sm font-bold transition-colors ${
                          selected ? 'bg-[var(--primary)] text-white' : 'bg-[var(--surface)] text-[var(--text)]'
                        } ${FOCUS_RING}`}
                      >
                        {unit.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          }

          if (unitCodes.length > 2) {
            return (
              <div key={state.code} className="space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4">
                {control}
                <label htmlFor={`${state.code}-unit`} className="sr-only">{t('capture.form.unit')}</label>
                <select
                  id={`${state.code}-unit`}
                  value={selectedUnit ?? ''}
                  onChange={(event) => updateSingle(
                    state.code,
                    numericInput(state.code, enteredValue, event.target.value || null, existing),
                  )}
                  className={`min-h-12 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--text)] ${FOCUS_RING}`}
                >
                  <option value="">{t('capture.form.unit')}</option>
                  {unitOptions.map((unit) => (
                    <option key={unit.code} value={unit.code}>{unit.label}</option>
                  ))}
                </select>
              </div>
            );
          }

          return <div key={state.code} className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4">{control}</div>;
        }

        if (attribute.value_type === 'choice') {
          const choices = allowedChoices(model, layout, state.code, currentSelections);
          return (
            <div key={state.code} className="space-y-2">
              <label htmlFor={state.code} className="flex items-center justify-between gap-3 text-sm font-bold text-[var(--text)]">
                <span>{label}</span>
                <span
                  aria-hidden={state.required ? undefined : true}
                  className="text-xs font-semibold text-[var(--text-secondary)]"
                >
                  {statusLabel}
                </span>
              </label>
              <select
                id={state.code}
                required={state.required}
                value={typeof semanticValue(existing) === 'string' ? String(semanticValue(existing)) : ''}
                aria-invalid={Boolean(fieldError)}
                aria-describedby={fieldError ? fieldErrorId : undefined}
                onChange={(event) => updateSingle(
                  state.code,
                  semanticInput(state.code, event.target.value, existing),
                )}
                className={`min-h-12 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--text)] ${FOCUS_RING}`}
              >
                <option value="">{t('capture.form.select')}</option>
                {choices.map((code) => (
                  <option key={code} value={code}>{catalogLabel(model.vocabByCode.get(code)!, locale)}</option>
                ))}
              </select>
              {fieldError && (
                <p
                  id={fieldErrorId}
                  role="alert"
                  className="text-sm font-semibold text-[var(--error-text)]"
                >
                  {fieldError}
                </p>
              )}
            </div>
          );
        }

        if (attribute.value_type === 'boolean') {
          const selected = semanticValue(existing);
          return (
            <fieldset
              key={state.code}
              aria-required={state.required}
              aria-invalid={Boolean(fieldError)}
              aria-describedby={fieldError ? fieldErrorId : undefined}
              className="space-y-2"
            >
              <legend className="flex w-full items-center justify-between gap-3 text-sm font-bold text-[var(--text)]">
                <span>{label}</span>
                <span
                  aria-hidden={state.required ? undefined : true}
                  className="text-xs font-semibold text-[var(--text-secondary)]"
                >
                  {statusLabel}
                </span>
              </legend>
              <div className="inline-flex w-full overflow-hidden rounded-xl border border-[var(--border)]">
                {([true, false] as const).map((option) => (
                  <button
                    key={String(option)}
                    type="button"
                    aria-pressed={selected === option}
                    onClick={() => updateSingle(
                      state.code,
                      semanticInput(state.code, option, existing),
                    )}
                    className={`min-h-12 flex-1 px-4 py-2 text-sm font-bold transition-colors ${
                      selected === option
                        ? 'bg-[var(--primary)] text-white'
                        : 'bg-[var(--surface)] text-[var(--text)]'
                    } ${FOCUS_RING}`}
                  >
                    {t(option ? 'capture.form.booleanYes' : 'capture.form.booleanNo')}
                  </button>
                ))}
              </div>
              {fieldError && (
                <p
                  id={fieldErrorId}
                  role="alert"
                  className="text-sm font-semibold text-[var(--error-text)]"
                >
                  {fieldError}
                </p>
              )}
            </fieldset>
          );
        }

        const type = attribute.value_type === 'date' ? 'date' : 'text';
        const current = semanticValue(existing);
        return (
          <div key={state.code} className="space-y-2">
            <label htmlFor={state.code} className="flex items-center justify-between gap-3 text-sm font-bold text-[var(--text)]">
              <span>{label}</span>
              <span
                aria-hidden={state.required ? undefined : true}
                className="text-xs font-semibold text-[var(--text-secondary)]"
              >
                {statusLabel}
              </span>
            </label>
            <input
              id={state.code}
              type={type}
              value={typeof current === 'string' ? current : ''}
              required={state.required}
              aria-invalid={Boolean(errorFor(state.code))}
              aria-describedby={fieldError ? fieldErrorId : undefined}
              onChange={(event) => updateSingle(
                state.code,
                semanticInput(state.code, event.target.value, existing),
              )}
              className={`min-h-12 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--text)] ${FOCUS_RING}`}
            />
            {fieldError && (
              <p
                id={fieldErrorId}
                role="alert"
                className="text-sm font-semibold text-[var(--error-text)]"
              >
                {fieldError}
              </p>
            )}
          </div>
        );
      })}

      {validation.errors.has('form') && (
        <p role="alert" className="text-sm font-semibold text-[var(--error-text)]">
          {validation.errors.get('form')}
        </p>
      )}
    </div>
  );
};
