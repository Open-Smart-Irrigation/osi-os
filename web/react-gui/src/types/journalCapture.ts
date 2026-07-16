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
