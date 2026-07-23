import { convertNumericValue } from './catalogModel';
import type {
  CaptureEntryValueInput,
  CaptureEntryValueOutput,
  JournalCaptureCatalogModel,
  JournalFieldInput,
  JournalFieldRule,
  JournalFieldState,
  JournalLayoutDefinition,
  JournalPredicate,
  JournalRequirement,
  JournalScalar,
  JournalSelections,
  JournalTemplateDefinition,
} from '../types/journalCapture';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizePredicate(value: unknown): JournalPredicate | undefined {
  if (!isRecord(value) || typeof value.field !== 'string' ||
      (value.op !== 'eq' && value.op !== 'in') || !('value' in value)) return undefined;
  if (value.op === 'in') {
    if (!Array.isArray(value.value) || !value.value.every(isScalar)) return undefined;
    return { field: value.field, op: value.op, value: value.value };
  }
  if (!isScalar(value.value)) return undefined;
  return { field: value.field, op: value.op, value: value.value };
}

function isScalar(value: unknown): value is JournalScalar {
  return value == null || typeof value === 'string' || typeof value === 'number' ||
    typeof value === 'boolean';
}

export function normalizeFieldRule(field: unknown): JournalFieldRule | null {
  if (typeof field === 'string') return field ? { code: field, required: false } : null;
  if (!isRecord(field)) return null;
  const code = field.code || field.attribute_code || field.field;
  if (typeof code !== 'string' || !code ||
      (field.required != null && typeof field.required !== 'boolean')) return null;
  const requiredIf = field.required_if == null ? undefined : normalizePredicate(field.required_if);
  const visibleIf = field.visible_if == null ? undefined : normalizePredicate(field.visible_if);
  if ((field.required_if != null && !requiredIf) || (field.visible_if != null && !visibleIf)) {
    return null;
  }
  return {
    code,
    required: field.required === true,
    ...(requiredIf ? { required_if: requiredIf } : {}),
    ...(visibleIf ? { visible_if: visibleIf } : {}),
  };
}

export function evaluatePredicate(
  predicate: unknown,
  selections: JournalSelections,
): { valid: boolean; matches: boolean } {
  const parsed = normalizePredicate(predicate);
  if (!parsed) return { valid: false, matches: false };
  const raw = selections[parsed.field];
  const actual = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  if (parsed.op === 'eq') {
    return { valid: true, matches: actual.some((value) => Object.is(value, parsed.value)) };
  }
  const expected = parsed.value as JournalScalar[];
  return { valid: true, matches: actual.some((value) => expected.includes(value)) };
}

interface MutableFieldState extends JournalFieldState {
  order: number;
}

function activityCode(selections: JournalSelections): string | undefined {
  const selected = selections.activity_code;
  if (typeof selected === 'string') return selected;
  return Array.isArray(selected) && typeof selected[0] === 'string' ? selected[0] : undefined;
}

// Operation-level field/requirement/product scoping plan (full_record@10,
// spec §0.1/§0.2): the operation choice code currently selected for
// attr.agroscope.operation, if any. Callers merge the live in-form value
// into `selections` before calling deriveFieldStates (spec §0.5) — this
// helper is agnostic to where that value came from.
function operationChoiceCode(selections: JournalSelections): string | undefined {
  const selected = selections['attr.agroscope.operation'];
  if (typeof selected === 'string') return selected;
  return Array.isArray(selected) && typeof selected[0] === 'string' ? selected[0] : undefined;
}

export function deriveFieldStates(
  template: JournalTemplateDefinition | Record<string, unknown>,
  layout: JournalLayoutDefinition | Record<string, unknown>,
  selections: JournalSelections,
): JournalFieldState[] {
  const states = new Map<string, MutableFieldState>();
  let order = 0;
  const addField = (input: JournalFieldInput | unknown, forceRequired = false) => {
    const rule = normalizeFieldRule(input);
    if (!rule) return;
    const visibleResult = rule.visible_if
      ? evaluatePredicate(rule.visible_if, selections)
      : { valid: true, matches: true };
    const requiredResult = rule.required_if
      ? evaluatePredicate(rule.required_if, selections)
      : { valid: true, matches: false };
    const visible = visibleResult.valid && visibleResult.matches;
    const required = visible && (forceRequired || rule.required ||
      (requiredResult.valid && requiredResult.matches));
    const existing = states.get(rule.code);
    if (existing) {
      existing.visible ||= visible;
      existing.required ||= required;
      return;
    }
    states.set(rule.code, {
      code: rule.code,
      visible,
      required,
      required_any_groups: [],
      order: order++,
    });
  };
  const addRequirement = (requirement: JournalRequirement | undefined) => {
    if (!requirement) return;
    for (const code of requirement.required ?? []) addField(code, true);
    for (const code of requirement.optional ?? []) addField(code);
    for (const family of requirement.required_any ?? []) {
      const groupIndex = requiredAnyGroupCount;
      requiredAnyGroupCount += 1;
      for (const code of family) {
        addField(code);
        const state = states.get(code);
        if (state && !state.required_any_groups.includes(groupIndex)) {
          state.required_any_groups.push(groupIndex);
        }
      }
    }
  };
  let requiredAnyGroupCount = 0;

  const rawTemplate = template as Partial<JournalTemplateDefinition>;
  const selectedActivity = activityCode(selections);
  for (const field of rawTemplate.fields ?? []) addField(field);
  for (const section of rawTemplate.sections ?? []) {
    // Slice E (full_record@5, R5): a scoped_by_activity section's per-entry
    // visible fields come from operation_fields_by_activity[activity], not
    // its own flat `fields` superset — mirroring quick_fields' resolution
    // axis below, but for one section of a template instead of the whole
    // template. No activity selected yet -> nothing from this section shows
    // (same "wait for an activity" behavior quick_fields already has).
    // Any field this section would otherwise hide but that activity_requirements
    // / conditional_groups mark required is still force-added by addRequirement
    // further down, regardless of this narrowing (see addField's merge-by-code
    // logic) — a required field can never be scoped out from under itself.
    if (section.scoped_by_activity) {
      // Operation-level field/requirement/product scoping plan (full_record@10,
      // spec §0.1/§0.2): when attr.agroscope.operation is selected AND
      // operation_fields_by_operation has an entry for it, that entry
      // REPLACES operation_fields_by_activity[activity] entirely for this
      // section — it is not merged with it. No operation selected, or the
      // selected operation has no entry here, falls back to the activity map
      // unchanged (every template/version before v10, the 9 Agroscope-
      // uncovered activities, and any future operation without an override).
      const selectedOperation = operationChoiceCode(selections);
      const operationFields = selectedOperation
        ? rawTemplate.operation_fields_by_operation?.[selectedOperation]
        : undefined;
      const scopedFields = operationFields ?? (selectedActivity
        ? rawTemplate.operation_fields_by_activity?.[selectedActivity]
        : undefined);
      for (const field of scopedFields ?? []) addField(field);
      continue;
    }
    for (const field of section.fields ?? []) addField(field);
  }
  const rawLayout = layout as Partial<JournalLayoutDefinition>;
  for (const field of rawLayout.fields ?? []) addField(field);
  // Slice BC (R1): `quick_fields` is a genuine new resolution axis, not a
  // variant of the old unconditional force-add below. When a template
  // declares it (farmer_quick@3+), the layout's minimum_fields/reading_fields
  // are NOT force-added — Quick visibility comes entirely from the
  // activity's own quick_fields entry (falling back to a minimal ['note']
  // set for an activity with no mapping), plus the current layout's
  // reading_fields when the activity is a measurement activity (`sampling`).
  // Plot-static context (the rest of minimum_fields) is deliberately never
  // added here for a quick_fields template: it renders read-only from the
  // plot's own settings instead of as a per-entry required input (Part 2 of
  // this slice).
  //
  // Every other template (full_record, research_observation, and any
  // template/version without quick_fields) keeps the exact pre-BC behavior:
  // minimum_fields force-added unconditionally, reunited with reading_fields
  // so the *effective* forced set is unchanged even though the raw
  // minimum_fields catalog row is now smaller (BC3 moved reading fields out
  // of minimum_fields at the catalog layer, not out of what these templates
  // resolve to) — this is the regression guard this slice requires.
  const quickFields = rawTemplate.quick_fields;
  if (quickFields) {
    const quickActivityFields = selectedActivity ? (quickFields[selectedActivity] ?? ['note']) : [];
    for (const field of quickActivityFields) addField(field);
    if (selectedActivity === 'sampling') {
      for (const field of rawLayout.reading_fields ?? []) addField(field);
    }
  } else {
    // Journal capture-followups Slice 1 (W1 Task 1.1b): a `minimum_fields`
    // entry that is also declared in the layout's own `static_context_fields`
    // (plot-static facts read-only from journal_plot_settings.context_json on
    // Quick, per BC3 above) is force-added as visible-but-optional here
    // instead of required — the same plot-static fact should not become a
    // hard-required per-entry input just because Full mode still resolves
    // minimum_fields the old way. A minimum_fields entry NOT in
    // static_context_fields stays force-required exactly as before (this
    // branch is version-generic; as of catalog v8 all served layouts have
    // minimum_fields == static_context_fields, so nothing is force-required
    // via this path today — open_field's attr.treated_area left minimum_fields
    // in v8). static_context_fields itself is never trimmed by this — Quick's
    // plot-context resolution (PlotContextFields / plotContextInputs) still
    // reads the full list untouched.
    const staticContextFields = rawLayout.static_context_fields ?? [];
    for (const field of rawLayout.minimum_fields ?? []) {
      addField(field, !staticContextFields.includes(field));
    }
    for (const field of rawLayout.reading_fields ?? []) addField(field, true);
  }

  addRequirement(rawTemplate.requirements);
  // Operation-level field/requirement/product scoping plan (full_record@10,
  // spec §0.2): operation_requirements[operation] REPLACES (not merges with)
  // activity_requirements[activity] under the same selected-operation-with-
  // an-entry condition as the fields resolution above. conditional_groups
  // below stays activity-keyed and ADDITIVE regardless of which branch fires
  // here — load-bearing for watering, whose operation_requirements entry is
  // deliberately empty because irrigation_details still supplies it.
  if (selectedActivity) {
    const selectedOperation = operationChoiceCode(selections);
    const operationRequirement = selectedOperation
      ? rawTemplate.operation_requirements?.[selectedOperation]
      : undefined;
    addRequirement(operationRequirement ?? rawTemplate.activity_requirements?.[selectedActivity]);
  }
  for (const group of rawTemplate.conditional_groups ?? []) {
    if (selectedActivity && group.activity_codes.includes(selectedActivity)) addRequirement(group);
  }
  for (const [condition, fields] of Object.entries(rawLayout.conditional_fields ?? {})) {
    const value = selections[condition];
    const enabled = Array.isArray(value) ? value.some(Boolean) : Boolean(value);
    if (enabled) for (const field of fields) addField(field, true);
  }

  return [...states.values()]
    .sort((left, right) => left.order - right.order)
    .map(({ order: _order, ...state }) => state);
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

function baseOutput(input: CaptureEntryValueInput): CaptureEntryValueOutput {
  return {
    attribute_code: input.attribute_code,
    ...(input.group_index == null ? {} : { group_index: input.group_index }),
    ...(input.value_status == null ? {} : { value_status: input.value_status }),
  };
}

export function buildEntryValues(
  model: JournalCaptureCatalogModel,
  inputs: CaptureEntryValueInput[],
): CaptureEntryValueOutput[] {
  const output: CaptureEntryValueOutput[] = [];
  for (const input of inputs) {
    const attribute = model.vocabByCode.get(input.attribute_code);
    if (!attribute || attribute.kind !== 'attribute') {
      throw new Error(`Unknown journal attribute: ${input.attribute_code}`);
    }
    const status = input.value_status ?? 'observed';
    if (status !== 'observed') {
      output.push(baseOutput(input));
      continue;
    }
    if (attribute.value_type === 'number') {
      const enteredValue = input.entered_value_num ?? input.value_num ??
        (typeof input.value === 'number' ? input.value : undefined);
      const enteredUnit = input.entered_unit_code ?? input.unit_code;
      if (!hasValue(enteredValue) && !hasValue(input.value)) continue;
      if (typeof enteredValue !== 'number' || typeof enteredUnit !== 'string') {
        throw new Error(`Numeric journal value requires entered value and unit: ${input.attribute_code}`);
      }
      const converted = convertNumericValue(model, input.attribute_code, enteredValue, enteredUnit);
      if ('ok' in converted) throw new Error(`${input.attribute_code}: ${converted.code}`);
      if (hasValue(input.value) &&
          (typeof input.value !== 'number' || !Object.is(input.value, converted.value_num))) {
        throw new Error(`Generic numeric value must equal canonical value for ${input.attribute_code}`);
      }
      if (input.value_num != null && !Object.is(input.value_num, converted.value_num)) {
        throw new Error(`Canonical value does not match conversion for ${input.attribute_code}`);
      }
      if (input.unit_code != null && input.unit_code !== converted.unit_code) {
        throw new Error(`Canonical unit does not match conversion for ${input.attribute_code}`);
      }
      output.push({ ...baseOutput(input), ...converted });
      continue;
    }
    const semanticValue = hasValue(input.value)
      ? input.value
      : hasValue(input.value_text)
        ? input.value_text
        : undefined;
    if (semanticValue === undefined) continue;
    output.push({ ...baseOutput(input), value: semanticValue });
  }
  return output;
}
