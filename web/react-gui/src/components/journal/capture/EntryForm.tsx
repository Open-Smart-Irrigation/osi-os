import React, { useEffect, useMemo, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import {
  allowedChoices,
  allowedUnits,
  catalogLabel,
  convertNumericValue,
  vocabLabelOrCode,
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

export type EntryFormTranslate = TFunction<'journal'>;

export interface EntryFormProps {
  model: JournalCaptureCatalogModel;
  layout: JournalLayoutDefinition;
  fieldStates: JournalFieldState[];
  values: CaptureEntryValueInput[];
  onChange: (
    inputs: CaptureEntryValueInput[],
    payload: CaptureEntryValueOutput[],
    valid: boolean,
    numberInputErrors: ReadonlyMap<string, string>,
  ) => void;
  selections?: JournalSelections;
  products?: JournalProductRow[];
  locale?: string;
  showValidation?: boolean;
  // Slice E (R5, E3): only 'full_record' groups its visible fields into an
  // open "Key values" set + a collapsible "More detail" set (see
  // groupOperationDetail below). Every other template/caller (Quick,
  // research_observation, and any caller that omits this prop) renders the
  // exact flat list it always has — passing this prop is opt-in, so existing
  // callers/tests are unaffected until they start passing 'full_record'.
  templateCode?: string;
  // POLISH 5 (treated_area prefill signal): an optional attribute_code ->
  // hint-text map for a small, unobtrusive supplementary line under a
  // field's control (e.g. "this number was defaulted from the plot area").
  // Business-logic-free here -- EntryForm has no idea which attribute this
  // is "for" or why; the caller decides both.
  fieldHints?: Readonly<Record<string, string>>;
  // Operation-level field/requirement/product scoping plan (full_record@10,
  // spec §2): an optional allow-list of journal_products.kind values to
  // narrow the product picker to (e.g. weeding operations offer none;
  // mineral_fertilization offers only 'mineral'). Undefined (every caller
  // that omits this prop, and any operation with no operation_product_kinds
  // entry) means no restriction — every active product shown, unchanged
  // behavior. The caller resolves this from the template's
  // operation_product_kinds map + the current attr.agroscope.operation
  // selection (allowedProductKindsForOperation in catalogModel.ts) — EntryForm
  // itself stays business-logic-free about what a "kind" means, same spirit
  // as fieldHints above.
  allowedProductKinds?: readonly string[];
  // Copy-entry-and-polish plan (2026-07-23, §C): an optional allow-list of
  // choice attribute codes to render as a read-only "confirmed" chip (the
  // selected choice's label plus a "change" button that reveals the normal
  // select) whenever that field already holds a value, instead of the open
  // dropdown. EntryForm has no idea which codes these are or why (same
  // business-logic-free spirit as fieldHints/allowedProductKinds above) — the
  // caller decides (e.g. DetailPanel's correction/copy forms pass
  // attr.agroscope.operation, since re-editing an already-recorded operation
  // is the rare path, not the default one). Undefined (every caller that
  // omits this prop, including the live capture flow) means no chip —
  // unchanged behavior.
  confirmedChoiceCodes?: readonly string[];
}

export interface EntryFormValidationResult {
  valid: boolean;
  payload: CaptureEntryValueOutput[];
  errors: Map<string, string>;
  numberInputErrors: ReadonlyMap<string, string>;
}

export interface EntryFormValidationRequest {
  model: JournalCaptureCatalogModel;
  layout: JournalLayoutDefinition;
  fieldStates: JournalFieldState[];
  inputs: CaptureEntryValueInput[];
  selections: JournalSelections;
  numberInputErrors: ReadonlyMap<string, string>;
  products: JournalProductRow[];
  t: EntryFormTranslate;
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

function conversionMessage(code: string, t: EntryFormTranslate): string {
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

export function validateEntryForm({
  model,
  layout,
  fieldStates,
  inputs,
  selections,
  numberInputErrors,
  products,
  t,
}: EntryFormValidationRequest): EntryFormValidationResult {
  const activeNumberInputErrors = pruneNumberErrors(
    numberInputErrors,
    model,
    fieldStates,
    inputs,
  );
  const visibleStates = visibleAttributeStates(model, fieldStates);
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
        if (typeof selected === 'string' && selected !== '' &&
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
      const inputError = activeNumberInputErrors.get(key) ?? activeNumberInputErrors.get(state.code);
      if (inputError) {
        errors.set(key, inputError);
        continue;
      }
      const enteredValue = row.entered_value_num ?? row.value_num ??
        (typeof row.value === 'number' ? row.value : null);
      const enteredUnit = row.entered_unit_code ?? row.unit_code;
      // An empty numeric field has nothing to unit-check: skip it regardless of
      // any residual unit selection. Clearing a number (e.g. a prefilled,
      // optional attr.treated_area) leaves entered_value_num null while
      // entered_unit_code keeps its last-picked unit — that is NOT an
      // incompatible-unit error, it is simply a blank optional field. A blank
      // *required* field is still caught by the required check above (line ~251,
      // `state.required && !rows.some(hasInputValue)`).
      if (enteredValue == null) continue;
      if (enteredUnit == null) {
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
  return {
    valid: errors.size === 0,
    payload,
    errors,
    numberInputErrors: activeNumberInputErrors,
  };
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

// Fix 2 (maintainer report, detailed activity vocabulary catalog v9): the
// choice fields the ActivityPicker's dependency chain restricts per
// activity (e.g. attr.agroscope.operation restricted by activity_code,
// attr.agroscope.device restricted in turn by the chosen operation) are
// what confirm what the farmer just picked -- on an activity where the
// device is optional, hiding them behind "More detail" left that
// confirmation invisible until the Review step. Generic over the layout's
// option_dependencies (any choice-restriction target) rather than a
// hardcoded attr.agroscope.* allowlist, so any future picker-scoped
// dependency chain gets the same treatment for free. Unit-only
// restrictions (e.g. a numeric field's allowed units narrowing with the
// chosen device) are not picker-confirmation fields and stay out of scope.
function activityDependencyTargets(layout: JournalLayoutDefinition): ReadonlySet<string> {
  return new Set(
    layout.option_dependencies
      .filter((dependency) => 'choices' in dependency.restrict)
      .map((dependency) => dependency.restrict.attribute_code),
  );
}

// Slice E (R5, E3): a field is "key" — always rendered in the open group,
// never eligible for the collapsible "More detail" group — when it is
// unconditionally required, a member of any required_any family, or (Fix 2)
// an activity-dependency choice target (see activityDependencyTargets
// above). The required_any case matters just as much as plain required: a
// required_any field's own `required` flag stays false (only one family
// member must have a value, not every member), but until one of them does,
// validateEntryForm flags every member as an error the user must be able to
// see and fix, so none of them may be hidden behind a collapsed disclosure
// either. This is what guarantees a required(-ish) field can never end up
// hidden while empty — the grouping itself, not the disclosure's
// open/closed state, is what's safe: a "key" field's group membership never
// depends on whether it currently holds a value.
function isKeyField(state: JournalFieldState, dependencyTargets: ReadonlySet<string>): boolean {
  return state.required || state.required_any_groups.length > 0 ||
    dependencyTargets.has(state.code);
}

// POLISH 6: a required_any member's own `required` flag stays false (only
// one family member must have a value, not every member) -- but until one of
// them does, validateEntryForm flags every member as an error the user must
// fix, exactly like a plain required field. Labelling it "Optional" (the old
// binary required/optional badge) actively misleads the user, so a
// required_any member gets its own distinct "choose one" indicator instead.
function fieldStatusLabel(state: JournalFieldState, t: EntryFormTranslate): string {
  if (state.required) return t('capture.form.required');
  if (state.required_any_groups.length > 0) return t('capture.form.requiredChooseOne');
  return t('capture.form.optional');
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
  templateCode,
  fieldHints,
  allowedProductKinds,
  confirmedChoiceCodes,
}) => {
  const { t, i18n } = useTranslation('journal');
  const locale = localeOverride || i18n.resolvedLanguage || i18n.language;
  const [numberInputErrors, setNumberInputErrors] = useState<Map<string, string>>(
    () => new Map(),
  );
  const [moreDetailOpen, setMoreDetailOpen] = useState(false);
  // §C: once the operator explicitly asks to "change" a confirmed choice
  // chip, it stays unlocked (reverts to the normal select) for the rest of
  // this form instance — there is no reason to re-collapse it back into a
  // chip after the very re-edit the button exists for.
  const [unlockedChoiceCodes, setUnlockedChoiceCodes] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const currentSelections = useMemo(
    () => mergedSelections(selections, values),
    [selections, values],
  );
  const visibleStates = useMemo(
    () => productFirst(visibleAttributeStates(model, fieldStates)),
    [fieldStates, model],
  );
  // v10 comment-everywhere decision (spec §0.4): `note` is not a real
  // attribute (it is not in model.vocabByCode at all, so visibleAttributeStates
  // above always excludes it — kind !== 'attribute'). It already resolves a
  // visible field state for every activity via full_record's unscoped `notes`
  // section (and via quick_fields on Quick) — this is a GUI-only render of
  // that EXISTING state, not a new map member anywhere in the catalog. Render
  // it whenever deriveFieldStates produced a visible `note` state, for both
  // Full and Quick (whatever fieldStates the caller passes in).
  const noteState = fieldStates.find((state) => state.code === 'note' && state.visible);
  // Slice E (R5, E3): full_record's operation section is a per-activity-
  // scoped superset (E2) that can still run to a dozen-plus fields for one
  // activity — progressive disclosure splits it into an always-open "Key
  // values" group and a collapsible "More detail" group. Quick and
  // research_observation are unaffected: they only group when the caller
  // passes templateCode="full_record" (JournalCaptureFlow/DetailPanel/
  // DraftsQueue do; nothing else needs to).
  const groupOperationDetail = templateCode === 'full_record';
  const dependencyTargets = useMemo(() => activityDependencyTargets(layout), [layout]);
  const keyStates = useMemo(
    () => (groupOperationDetail
      ? visibleStates.filter((state) => isKeyField(state, dependencyTargets))
      : visibleStates),
    [dependencyTargets, groupOperationDetail, visibleStates],
  );
  const moreDetailStates = useMemo(
    () => (groupOperationDetail
      ? visibleStates.filter((state) => !isKeyField(state, dependencyTargets))
      : []),
    [dependencyTargets, groupOperationDetail, visibleStates],
  );
  const validation = validateEntryForm({
    model,
    layout,
    fieldStates,
    inputs: values,
    selections,
    numberInputErrors,
    products,
    t,
  });
  const activeProducts = useMemo(
    () => products
      .filter(({ active, deleted_at: deletedAt }) => active === 1 && deletedAt == null)
      // Operation-level field/requirement/product scoping plan (full_record@10,
      // spec §2): undefined allowedProductKinds means no restriction (every
      // caller/template before v10, and any operation with no
      // operation_product_kinds entry) — unchanged behavior. When present,
      // narrow to only those kinds; an empty result degrades to the existing
      // noProducts message below plus the free-text attr.product escape, not
      // a dead end (the edge never enforces kind — attr.product free text is
      // always available regardless).
      .filter((product) => allowedProductKinds == null || allowedProductKinds.includes(product.kind))
      .sort((left, right) => left.name.localeCompare(right.name, locale)),
    [allowedProductKinds, locale, products],
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
    const result = validateEntryForm({
      model,
      layout,
      fieldStates,
      inputs: next,
      selections,
      numberInputErrors: inputErrors,
      products,
      t,
    });
    if (!sameErrors(numberInputErrors, result.numberInputErrors)) {
      setNumberInputErrors(new Map(result.numberInputErrors));
    }
    onChange(next, result.payload, result.valid, result.numberInputErrors);
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

  const renderField = (state: JournalFieldState): React.ReactNode => {
    const attribute = model.vocabByCode.get(state.code);
    if (!attribute) return null;
    const rows = fieldValues(values, state.code);
    const existing = rows[0];
    const label = catalogLabel(attribute, locale);
    const requiredAnyGroup = state.required_any_groups.length > 0;
    const statusLabel = fieldStatusLabel(state, t);
    // POLISH 6: a required_any member is just as "effectively required" as a
    // plain required field until one family member has a value, so its
    // status badge is exposed to the accessible name the same way a
    // required field's already is (never hidden purely because the raw
    // `required` flag itself is false).
    const statusHidden = state.required || requiredAnyGroup ? undefined : true;
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
              aria-hidden={statusHidden}
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
            requiredAnyGroup={requiredAnyGroup}
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
          requiredAnyGroup={requiredAnyGroup}
          unitLabel={unitCodes.length === 1 ? selectedUnitLabel : undefined}
          error={numberError}
          hint={fieldHints?.[state.code]}
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
      const selectedChoiceCode = semanticValue(existing);
      // §C: a confirmed-choice chip only ever replaces the SELECT for a
      // field that (a) the host opted into via confirmedChoiceCodes, (b)
      // currently holds a value (an empty field has nothing to "confirm" —
      // it must still render as a normal select so the operator can make a
      // first choice), and (c) has not been explicitly unlocked via "change"
      // yet.
      const confirmedChoiceValue = confirmedChoiceCodes?.includes(state.code) &&
        !unlockedChoiceCodes.has(state.code) &&
        typeof selectedChoiceCode === 'string' && selectedChoiceCode !== ''
        ? selectedChoiceCode
        : null;
      if (confirmedChoiceValue) {
        const chipLabelId = `${state.code}-chip-label`;
        return (
          <div key={state.code} className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span id={chipLabelId} className="text-sm font-bold text-[var(--text)]">{label}</span>
            </div>
            <div
              role="group"
              aria-labelledby={chipLabelId}
              aria-describedby={fieldError ? fieldErrorId : undefined}
              className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--secondary-bg)] px-3 py-2"
            >
              <span className="font-semibold text-[var(--text)]">
                {vocabLabelOrCode(confirmedChoiceValue, model, locale)}
              </span>
              <button
                type="button"
                onClick={() => setUnlockedChoiceCodes((current) => new Set(current).add(state.code))}
                className={`rounded-lg px-2 py-1 text-xs font-bold text-[var(--primary)] hover:bg-[var(--card)] ${FOCUS_RING}`}
              >
                {t('capture.form.change', { field: label })}
              </button>
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
          </div>
        );
      }
      return (
        <div key={state.code} className="space-y-2">
          <label htmlFor={state.code} className="flex items-center justify-between gap-3 text-sm font-bold text-[var(--text)]">
            <span>{label}</span>
            <span
              aria-hidden={statusHidden}
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
              aria-hidden={statusHidden}
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
            aria-hidden={statusHidden}
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
  };

  // v10 comment-everywhere decision (spec §0.4): stores its text into
  // `values` under attribute_code 'note' via the same updateSingle/emit path
  // every other field uses. Safe: 'note' is not a member of
  // visibleAttributeStates (kind !== 'attribute' — model.vocabByCode has no
  // 'note' row), so it is filtered out of visibleInputs before
  // buildEntryValues ever sees it (buildEntryValues would otherwise throw:
  // "Unknown journal attribute: note"). The caller reads it back out of the
  // raw `values` array to thread onto the entry's top-level `note` field
  // (JournalCaptureFlow's currentNoteValue).
  const renderNote = (): React.ReactNode => {
    if (!noteState) return null;
    const existing = fieldValues(values, 'note')[0];
    const current = semanticValue(existing);
    return (
      <div key="note" className="space-y-2">
        <label htmlFor="note" className="text-sm font-bold text-[var(--text)]">
          {t('capture.form.note')}
        </label>
        <textarea
          id="note"
          rows={3}
          value={typeof current === 'string' ? current : ''}
          onChange={(event) => updateSingle(
            'note',
            semanticInput('note', event.target.value, existing),
          )}
          className={`w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)] ${FOCUS_RING}`}
        />
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {groupOperationDetail ? (
        <>
          {keyStates.length > 0 && (
            <p className="text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]">
              {t('capture.form.keyValues')}
            </p>
          )}
          {keyStates.map(renderField)}
          {moreDetailStates.length > 0 && (
            <div id="entry-form-more-detail" className="rounded-2xl border border-[var(--border)] bg-[var(--card)]">
              {/* The WAI-ARIA disclosure pattern (button + aria-expanded/
                  aria-controls, content conditionally rendered) rather than
                  native <details>/<summary>: React 18's synthetic event
                  system does not deliver the native (non-bubbling) `toggle`
                  event reliably, so a controlled <details open> would not
                  respond to clicks/keyboard activation at all. A <button> is
                  natively keyboard-operable (Enter/Space) in every browser
                  and jsdom, and the content is a genuine unmount when
                  collapsed — not merely CSS-hidden — so it is out of the
                  DOM/accessibility tree, never just visually tucked away. */}
              <button
                type="button"
                aria-expanded={moreDetailOpen}
                aria-controls="entry-form-more-detail-content"
                onClick={() => setMoreDetailOpen((open) => !open)}
                className={`flex min-h-12 w-full items-center justify-between gap-2 rounded-2xl px-4 py-3 text-left text-sm font-bold text-[var(--text)] ${FOCUS_RING}`}
              >
                <span>{t('capture.form.moreDetail')}</span>
                <span aria-hidden="true">{moreDetailOpen ? '−' : '+'}</span>
              </button>
              {moreDetailOpen && (
                <div
                  id="entry-form-more-detail-content"
                  className="space-y-4 border-t border-[var(--border)] p-4"
                >
                  {moreDetailStates.map(renderField)}
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        visibleStates.map(renderField)
      )}

      {renderNote()}

      {validation.errors.has('form') && (
        <p role="alert" className="text-sm font-semibold text-[var(--error-text)]">
          {validation.errors.get('form')}
        </p>
      )}
    </div>
  );
};
