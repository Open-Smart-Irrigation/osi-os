import type { JournalVocabRow, ValueStatus } from './journal';

export type JournalScalar = string | number | boolean | null;
export type JournalSelectionValue = JournalScalar | JournalScalar[] | undefined;
export type JournalSelections = Record<string, JournalSelectionValue>;

export interface ActivityDependentSelection {
  attribute_code: string;
  value: string;
}

export interface ActivityLeafSelection {
  activity_code: string;
  dependent_selections: ActivityDependentSelection[];
}

export interface JournalPredicate {
  field: string;
  op: 'eq' | 'in';
  value: JournalScalar | JournalScalar[];
}

export interface JournalFieldRule {
  code: string;
  required: boolean;
  required_if?: JournalPredicate;
  visible_if?: JournalPredicate;
}

export type JournalFieldInput = string | {
  code?: unknown;
  attribute_code?: unknown;
  field?: unknown;
  required?: unknown;
  required_if?: unknown;
  visible_if?: unknown;
};

export interface JournalTemplateSection {
  code: string;
  fields: JournalFieldInput[];
  include_scope?: 'core' | 'custom';
  // Slice E (full_record@5, R5): when true, this section's *visible* fields
  // per entry are resolved from the template's own
  // `operation_fields_by_activity[activity_code]` map instead of this
  // section's flat `fields` list (which stays the declared superset every
  // per-activity entry must be a member of). Absent on every other
  // section/template.
  scoped_by_activity?: boolean;
}

export interface JournalRequirement {
  required: string[];
  optional: string[];
  required_any: string[][];
}

export interface JournalConditionalGroup extends JournalRequirement {
  code: string;
  activity_codes: string[];
}

export interface JournalTemplateDefinition {
  code: string;
  version: number;
  fields: JournalFieldInput[];
  sections: JournalTemplateSection[];
  carry_forward: string[];
  max_primary_fields?: number;
  require_explicit_choices: boolean;
  show_standard_mappings: boolean;
  activity_requirements: Record<string, JournalRequirement>;
  conditional_groups: JournalConditionalGroup[];
  requirements: JournalRequirement;
  // Slice BC (farmer_quick@3, R1): activity_code -> field-code list. When
  // present, deriveFieldStates resolves Quick visibility per activity from
  // this map instead of force-adding the layout's minimum_fields to every
  // entry regardless of activity. Absent on every other template/version.
  quick_fields?: Record<string, string[]>;
  // Slice E (full_record@5, R5): activity_code -> field-code list scoping the
  // one `scoped_by_activity` section's visibility (see that flag above).
  // Present only alongside a scoped_by_activity section; absent otherwise.
  operation_fields_by_activity?: Record<string, string[]>;
  // Operation-level field/requirement/product scoping plan (full_record@10,
  // 2026-07-23): operation-CHOICE-CODE -> field-code list, consulted by
  // deriveFieldStates INSTEAD OF (replacing, never merging with)
  // operation_fields_by_activity[activity] whenever the current
  // attr.agroscope.operation selection names a key present here. Partial by
  // design (spec §0.6) — a key absent here falls back to the activity map,
  // so a future vocab addition never invalidates a pinned template row. Keys
  // are FULL choice codes (`agroscope.operation.<op>`), matching what
  // EntryForm/the picker store for attr.agroscope.operation.
  operation_fields_by_operation?: Record<string, string[]>;
  // Operation-level field/requirement/product scoping plan (full_record@10):
  // the operation-keyed twin of activity_requirements — REPLACES (never
  // merges with) activity_requirements[activity] when the selected
  // operation has an entry here. Same partial-by-design rule as
  // operation_fields_by_operation.
  operation_requirements?: Record<string, JournalRequirement>;
  // Operation-level field/requirement/product scoping plan (full_record@10):
  // operation-CHOICE-CODE -> allowed journal_products.kind[] — a GUI-only
  // product-picker filter (the edge never enforces it; attr.product free
  // text is always an escape). Absent key or absent map -> no restriction
  // (every active kind shown), matching today's behavior.
  operation_product_kinds?: Record<string, string[]>;
}

export interface JournalDependencyCondition {
  attribute_code: string;
  equals: string;
}

export interface JournalChoiceRestriction {
  attribute_code: string;
  choices: string[];
}

export interface JournalUnitRestriction {
  attribute_code: string;
  units: string[];
}

export type JournalOptionDependency = {
  when: JournalDependencyCondition;
  restrict: JournalChoiceRestriction | JournalUnitRestriction;
  source_category?: string;
};

export interface JournalLayoutDefinition {
  code: string;
  version: number;
  activity_codes: string[];
  supported_templates: string[];
  fields: JournalFieldInput[];
  minimum_fields: string[];
  conditional_fields: Record<string, string[]>;
  denominator_contract: string[];
  option_dependencies: JournalOptionDependency[];
  // Slice BC (layout v3, R1/BC3): plot-static facts split out of
  // minimum_fields — carried in journal_plot_settings.context_json and
  // rendered read-only on the capture form instead of as a per-entry input.
  // Optional so pre-BC fixtures/tests that build a layout literal without it
  // keep compiling; deriveFieldStates treats an absent list as empty.
  static_context_fields?: string[];
  // Slice BC (layout v3, R1/BC3): per-measurement reading fields split out of
  // minimum_fields — visible only on the `sampling` Quick activity, not on
  // every entry regardless of activity.
  reading_fields?: string[];
  // Detailed activity vocabulary plan (layout v9, 2026-07-22): declares which
  // choice-dependency targets the activity picker should expand through
  // before emitting a leaf (deriveActivityLeaves in catalogModel.ts) and which
  // targets activityShortlist.ts's recents matching considers. Absent (every
  // layout before open_field@9, including the frozen agroscope_open_field)
  // means "expand/match every choice target" — today's deepest-expansion
  // behaviour, unchanged.
  picker_targets?: string[];
}

export interface JournalCaptureCatalogModel {
  vocabByCode: Map<string, JournalVocabRow>;
  templates: Map<string, JournalTemplateDefinition>;
  layouts: Map<string, JournalLayoutDefinition>;
}

export type CatalogModelResult =
  | { ok: true; model: JournalCaptureCatalogModel }
  | { ok: false; errors: string[] };

export interface JournalFieldState {
  code: string;
  visible: boolean;
  required: boolean;
  required_any_groups: number[];
}

export interface CaptureEntryValueInput {
  attribute_code: string;
  group_index?: number;
  value_status?: ValueStatus;
  value?: JournalScalar;
  value_num?: number | null;
  value_text?: string | null;
  unit_code?: string | null;
  entered_value_num?: number | null;
  entered_unit_code?: string | null;
}

export interface CaptureEntryValueOutput {
  attribute_code: string;
  group_index?: number;
  value_status?: ValueStatus;
  value?: JournalScalar;
  value_num?: number;
  value_text?: string;
  unit_code?: string;
  entered_value_num?: number;
  entered_unit_code?: string;
}

export type NumericConversionResult =
  | {
    value_num: number;
    unit_code: string;
    entered_value_num: number;
    entered_unit_code: string;
  }
  | { ok: false; code: string };
