import type { JournalCatalog, JournalDefinitionRow, JournalVocabRow } from '../types/journal';
import type {
  ActivityLeafSelection,
  CatalogModelResult,
  JournalCaptureCatalogModel,
  JournalConditionalGroup,
  JournalDependencyCondition,
  JournalFieldInput,
  JournalLayoutDefinition,
  JournalOptionDependency,
  JournalRequirement,
  JournalSelections,
  JournalTemplateDefinition,
  JournalTemplateSection,
  NumericConversionResult,
} from '../types/journalCapture';

const TOP_LEVEL_FIELDS = new Set([
  'entry_uuid', 'owner_user_uuid', 'user_id', 'author_principal_uuid', 'author_label',
  'plot_uuid', 'zone_id', 'zone_uuid', 'device_eui', 'season_uuid', 'season_crop',
  'season_variety', 'campaign_uuid', 'protocol_code', 'protocol_version',
  'observation_unit_code', 'pass_uuid', 'batch_uuid', 'activity_code', 'template_code',
  'template_version', 'layout_code', 'layout_version', 'catalog_version', 'occurred_start',
  'occurred_start_local', 'occurred_end', 'occurred_end_local', 'occurred_timezone',
  'occurred_utc_offset_minutes', 'recorded_at', 'origin', 'status', 'note', 'context',
  'context_json', 'voided_at', 'voided_by_principal_uuid', 'void_reason', 'sync_version',
  'base_sync_version', 'gateway_device_eui', 'created_at', 'updated_at', 'deleted_at',
  'values',
]);

interface UnitFacts {
  quantityKind: string;
  basis: string;
  dimension: string;
  canonicalUnitCode: string;
  scale: number;
  offset: number;
}

interface DefinitionDomain {
  vocabByCode: Map<string, JournalVocabRow>;
  templateCodes: Set<string>;
  layoutCodes: Set<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isActive(row: JournalVocabRow): boolean {
  return row.active === 1 && row.deleted_at == null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null;
  return [...value];
}

function fieldCode(field: JournalFieldInput): string | null {
  if (typeof field === 'string') return field;
  const code = field.code || field.attribute_code || field.field;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

function knownField(vocabByCode: Map<string, JournalVocabRow>, code: string): boolean {
  if (TOP_LEVEL_FIELDS.has(code)) return true;
  return vocabByCode.get(code)?.kind === 'attribute';
}

function isCalendarDate(value: unknown): boolean {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

function predicateValueMatchesDomain(
  field: string,
  value: unknown,
  domain: DefinitionDomain,
): boolean {
  if (field === 'activity_code') return typeof value === 'string' &&
    domain.vocabByCode.get(value)?.kind === 'activity';
  if (field === 'template_code') return typeof value === 'string' &&
    domain.templateCodes.has(value);
  if (field === 'layout_code') return typeof value === 'string' && domain.layoutCodes.has(value);
  const attribute = domain.vocabByCode.get(field);
  if (!attribute || attribute.kind !== 'attribute') return true;
  if (attribute.value_type === 'choice') {
    if (typeof value !== 'string') return false;
    const choice = domain.vocabByCode.get(value);
    return choice?.kind === 'choice' && choice.parent_code === attribute.code;
  }
  if (attribute.value_type === 'boolean') return typeof value === 'boolean';
  if (attribute.value_type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (attribute.value_type === 'date') return isCalendarDate(value);
  if (attribute.value_type === 'text') return typeof value === 'string';
  return false;
}

function validPredicate(
  value: unknown,
  domain: DefinitionDomain,
): boolean {
  if (!isRecord(value) || typeof value.field !== 'string' ||
      (value.op !== 'eq' && value.op !== 'in') || !('value' in value) ||
      !knownField(domain.vocabByCode, value.field)) return false;
  const field = value.field;
  if (value.op === 'in') {
    return Array.isArray(value.value) &&
      value.value.every((entry) => predicateValueMatchesDomain(field, entry, domain));
  }
  return predicateValueMatchesDomain(field, value.value, domain);
}

function validFields(
  fields: unknown,
  domain: DefinitionDomain,
): fields is JournalFieldInput[] {
  if (!Array.isArray(fields)) return false;
  return fields.every((field) => {
    if (typeof field === 'string') return knownField(domain.vocabByCode, field);
    if (!isRecord(field)) return false;
    const code = fieldCode(field);
    if (!code || !knownField(domain.vocabByCode, code)) return false;
    if (field.required != null && typeof field.required !== 'boolean') return false;
    if (field.required_if != null && !validPredicate(field.required_if, domain)) return false;
    if (field.visible_if != null && !validPredicate(field.visible_if, domain)) return false;
    return true;
  });
}

function parseRequirement(
  value: unknown,
  vocabByCode: Map<string, JournalVocabRow>,
): JournalRequirement | null {
  if (value == null) return { required: [], optional: [], required_any: [] };
  if (!isRecord(value)) return null;
  const required = value.required == null ? [] : stringArray(value.required);
  const optional = value.optional == null ? [] : stringArray(value.optional);
  if (!required || !optional || required.some((code) => !knownField(vocabByCode, code)) ||
      optional.some((code) => !knownField(vocabByCode, code))) return null;
  let requiredAny: string[][] = [];
  if (value.required_any != null) {
    if (!Array.isArray(value.required_any)) return null;
    requiredAny = [];
    for (const family of value.required_any) {
      const parsed = stringArray(family);
      if (!parsed || parsed.length === 0 || parsed.some((code) => !knownField(vocabByCode, code))) {
        return null;
      }
      requiredAny.push(parsed);
    }
  }
  return { required, optional, required_any: requiredAny };
}

function parseSections(
  value: unknown,
  domain: DefinitionDomain,
): JournalTemplateSection[] | null {
  if (value == null) return [];
  if (!Array.isArray(value)) return null;
  const sections: JournalTemplateSection[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.code !== 'string') return null;
    const includeScope = raw.include_scope;
    if (includeScope != null && includeScope !== 'core' && includeScope !== 'custom') return null;
    const rawFields = raw.fields == null ? [] : raw.fields;
    if (!validFields(rawFields, domain)) return null;
    const fields = [...rawFields];
    if (includeScope) {
      const included = [...domain.vocabByCode.values()]
        .filter((row) => row.kind === 'attribute' && row.scope === includeScope && isActive(row))
        .sort((left, right) => left.sort_order - right.sort_order || left.code.localeCompare(right.code));
      for (const row of included) {
        if (!fields.some((field) => fieldCode(field) === row.code)) fields.push(row.code);
      }
    }
    sections.push({ code: raw.code, fields, ...(includeScope ? { include_scope: includeScope } : {}) });
  }
  return sections;
}

// The set of field codes a template actually shows the user: its top-level
// `fields` plus every (already-expanded) section's `fields`. Used to guard
// `carry_forward` below — see that call site for why.
function visibleFieldCodes(
  fields: JournalFieldInput[],
  sections: JournalTemplateSection[],
): Set<string> {
  const codes = new Set<string>();
  for (const field of fields) {
    const code = fieldCode(field);
    if (code) codes.add(code);
  }
  for (const section of sections) {
    for (const field of section.fields) {
      const code = fieldCode(field);
      if (code) codes.add(code);
    }
  }
  return codes;
}

function parseTemplate(
  row: JournalDefinitionRow,
  domain: DefinitionDomain,
): JournalTemplateDefinition | null {
  if (row.catalog_errors.includes('definition_json') || !isRecord(row.definition)) return null;
  const definition = row.definition;
  const fields = definition.fields == null ? [] : definition.fields;
  if (!validFields(fields, domain)) return null;
  const sections = parseSections(definition.sections, domain);
  if (!sections) return null;
  const rootRequirement = parseRequirement(definition, domain.vocabByCode);
  const requirements = parseRequirement(definition.requirements, domain.vocabByCode);
  if (!rootRequirement || !requirements) return null;
  const carryForward = definition.carry_forward == null ? [] : stringArray(definition.carry_forward);
  if (!carryForward || carryForward.some((code) => !knownField(domain.vocabByCode, code))) return null;
  // A carry_forward code must be part of this template's own visible field
  // set (top-level `fields` or a section's `fields`) — otherwise a value is
  // silently carried into the entry with no field for the user to see or
  // correct it. This was the P4 bug in farmer_quick@1 (Task 27): shipped
  // alone, this guard would reject that live definition, which is exactly
  // why the visibility fix (farmer_quick@2) must ship atomically with it.
  const visible = visibleFieldCodes(fields, sections);
  if (carryForward.some((code) => !visible.has(code))) return null;
  const maxPrimaryFields = definition.max_primary_fields;
  if (maxPrimaryFields != null &&
      (!Number.isInteger(maxPrimaryFields) || (maxPrimaryFields as number) <= 0)) return null;
  const requireExplicitChoices = definition.require_explicit_choices ?? false;
  const showStandardMappings = definition.show_standard_mappings ?? false;
  if (typeof requireExplicitChoices !== 'boolean' || typeof showStandardMappings !== 'boolean') {
    return null;
  }
  const combinedRequirements: JournalRequirement = {
    required: [...rootRequirement.required, ...requirements.required],
    optional: [...rootRequirement.optional, ...requirements.optional],
    required_any: [...rootRequirement.required_any, ...requirements.required_any],
  };
  const activityRequirements: Record<string, JournalRequirement> = {};
  if (definition.activity_requirements != null) {
    if (!isRecord(definition.activity_requirements)) return null;
    for (const [activityCode, raw] of Object.entries(definition.activity_requirements)) {
      const activity = domain.vocabByCode.get(activityCode);
      const parsed = parseRequirement(raw, domain.vocabByCode);
      if (!activity || activity.kind !== 'activity' || !parsed) return null;
      activityRequirements[activityCode] = parsed;
    }
  }
  const conditionalGroups: JournalConditionalGroup[] = [];
  if (definition.conditional_groups != null) {
    if (!Array.isArray(definition.conditional_groups)) return null;
    for (const raw of definition.conditional_groups) {
      if (!isRecord(raw) || typeof raw.code !== 'string') return null;
      const activities = stringArray(raw.activity_codes);
      const requirement = parseRequirement(raw, domain.vocabByCode);
      if (!activities || !requirement ||
          activities.some((code) => domain.vocabByCode.get(code)?.kind !== 'activity')) {
        return null;
      }
      conditionalGroups.push({ code: raw.code, activity_codes: activities, ...requirement });
    }
  }
  return {
    code: row.code,
    version: row.version,
    fields: [...fields],
    sections,
    carry_forward: carryForward,
    ...(typeof maxPrimaryFields === 'number' ? { max_primary_fields: maxPrimaryFields } : {}),
    require_explicit_choices: requireExplicitChoices,
    show_standard_mappings: showStandardMappings,
    activity_requirements: activityRequirements,
    conditional_groups: conditionalGroups,
    requirements: combinedRequirements,
  };
}

function parseConditionalFields(
  value: unknown,
  vocabByCode: Map<string, JournalVocabRow>,
): Record<string, string[]> | null {
  if (value == null) return {};
  if (!isRecord(value)) return null;
  const result: Record<string, string[]> = {};
  for (const [condition, rawFields] of Object.entries(value)) {
    const fields = stringArray(rawFields);
    if (!fields || fields.some((code) => !knownField(vocabByCode, code))) return null;
    result[condition] = fields;
  }
  return result;
}

function parseCondition(value: unknown): JournalDependencyCondition | null {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'attribute_code' && key !== 'equals') ||
      typeof value.attribute_code !== 'string' || value.attribute_code.length === 0 ||
      typeof value.equals !== 'string' || value.equals.length === 0) return null;
  return { attribute_code: value.attribute_code, equals: value.equals };
}

function parseDependencies(value: unknown): JournalOptionDependency[] | null {
  if (!Array.isArray(value)) return null;
  const dependencies: JournalOptionDependency[] = [];
  const duplicateRules = new Map<string, { kind: 'choices' | 'units'; values: string[] }>();
  for (const raw of value) {
    if (!isRecord(raw) || Object.keys(raw).some((key) =>
      key !== 'when' && key !== 'restrict' && key !== 'source_category')) return null;
    if (raw.source_category != null &&
        (typeof raw.source_category !== 'string' || raw.source_category.trim() === '')) return null;
    const when = parseCondition(raw.when);
    if (!when || !isRecord(raw.restrict) || typeof raw.restrict.attribute_code !== 'string') {
      return null;
    }
    const restrictKeys = Object.keys(raw.restrict);
    if (restrictKeys.some((key) => key !== 'attribute_code' && key !== 'choices' && key !== 'units')) {
      return null;
    }
    const choices = stringArray(raw.restrict.choices);
    const units = stringArray(raw.restrict.units);
    if ((choices == null) === (units == null)) return null;
    const values = choices ?? units;
    if (!values || values.length === 0 || new Set(values).size !== values.length) return null;
    const kind = choices ? 'choices' : 'units';
    const duplicateKey = [
      when.attribute_code,
      when.equals,
      raw.restrict.attribute_code,
    ].join('\u0000');
    const previous = duplicateRules.get(duplicateKey);
    if (previous && (previous.kind !== kind || previous.values.length !== values.length ||
        previous.values.some((entry) => !values.includes(entry)))) return null;
    duplicateRules.set(duplicateKey, { kind, values });
    dependencies.push({
      when,
      restrict: choices
        ? { attribute_code: raw.restrict.attribute_code, choices }
        : { attribute_code: raw.restrict.attribute_code, units: units ?? [] },
      ...(typeof raw.source_category === 'string' ? { source_category: raw.source_category } : {}),
    });
  }
  return dependencies;
}

function hasChoiceDependencyCycle(dependencies: JournalOptionDependency[]): boolean {
  const edges = new Map<string, Set<string>>();
  for (const dependency of dependencies) {
    if (!('choices' in dependency.restrict)) continue;
    const targets = edges.get(dependency.when.attribute_code) ?? new Set<string>();
    targets.add(dependency.restrict.attribute_code);
    edges.set(dependency.when.attribute_code, targets);
  }
  const state = new Map<string, number>();
  const visit = (code: string): boolean => {
    if (state.get(code) === 1) return true;
    if (state.get(code) === 2) return false;
    state.set(code, 1);
    for (const target of edges.get(code) ?? []) if (visit(target)) return true;
    state.set(code, 2);
    return false;
  };
  return [...edges.keys()].some(visit);
}

function unitFacts(row: JournalVocabRow): UnitFacts | null {
  if (row.kind !== 'unit' || !row.quantity_kind || !row.basis || !isRecord(row.constraints) ||
      row.catalog_errors.includes('constraints_json') ||
      typeof row.constraints.dimension !== 'string' || !row.constraints.dimension ||
      !isRecord(row.constraints.to_canonical)) {
    return null;
  }
  const conversion = row.constraints.to_canonical;
  if (typeof conversion.unit_code !== 'string' || !conversion.unit_code ||
      typeof conversion.scale !== 'number' ||
      !Number.isFinite(conversion.scale) || conversion.scale <= 0 ||
      typeof conversion.offset !== 'number' || !Number.isFinite(conversion.offset)) return null;
  return {
    quantityKind: row.quantity_kind,
    basis: row.basis,
    dimension: row.constraints.dimension,
    canonicalUnitCode: conversion.unit_code,
    scale: conversion.scale,
    offset: conversion.offset,
  };
}

function numericAttributeValid(attribute: JournalVocabRow): boolean {
  if (attribute.kind !== 'attribute' || attribute.value_type !== 'number' ||
      !attribute.quantity_kind || !attribute.basis || !isActive(attribute) ||
      !isRecord(attribute.constraints) || attribute.catalog_errors.includes('constraints_json')) {
    return false;
  }
  for (const key of ['min', 'max'] as const) {
    if (Object.prototype.hasOwnProperty.call(attribute.constraints, key)) {
      const value = attribute.constraints[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    }
  }
  if (typeof attribute.constraints.min === 'number' &&
      typeof attribute.constraints.max === 'number' &&
      attribute.constraints.min > attribute.constraints.max) return false;
  if (Object.prototype.hasOwnProperty.call(attribute.constraints, 'step')) {
    const step = attribute.constraints.step;
    if (typeof step !== 'number' || !Number.isFinite(step) || step <= 0) return false;
  }
  for (const key of ['requires_explicit_unit', 'allow_default_unit'] as const) {
    if (Object.prototype.hasOwnProperty.call(attribute.constraints, key) &&
        typeof attribute.constraints[key] !== 'boolean') return false;
  }
  if (Object.prototype.hasOwnProperty.call(attribute.constraints, 'semantic_discriminator') &&
      attribute.constraints.semantic_discriminator !== 'unit_code') return false;
  if (attribute.default_unit_code == null) {
    return attribute.constraints.requires_explicit_unit === true &&
      attribute.constraints.allow_default_unit === false &&
      attribute.constraints.semantic_discriminator === 'unit_code';
  }
  return attribute.default_unit_code.length > 0;
}

function validUnitForAttribute(
  model: JournalCaptureCatalogModel,
  attribute: JournalVocabRow,
  unitCode: string,
): { facts: UnitFacts; canonical: JournalVocabRow } | { error: string } {
  const unit = model.vocabByCode.get(unitCode);
  if (!unit || unit.kind !== 'unit') return { error: 'unknown_unit' };
  const facts = unitFacts(unit);
  if (!facts) return { error: 'invalid_catalog' };
  if (!isActive(unit)) return { error: 'inactive_unit' };
  if (facts.basis !== attribute.basis) return { error: 'cross_basis_forbidden' };
  if (facts.quantityKind !== attribute.quantity_kind) return { error: 'unit_incompatible' };
  const canonical = model.vocabByCode.get(facts.canonicalUnitCode);
  const canonicalFacts = canonical && unitFacts(canonical);
  if (!canonical || !canonicalFacts || !isActive(canonical) || canonicalFacts.scale !== 1 ||
      canonicalFacts.offset !== 0 || canonicalFacts.canonicalUnitCode !== canonical.code ||
      canonicalFacts.quantityKind !== facts.quantityKind || canonicalFacts.basis !== facts.basis ||
      canonicalFacts.dimension !== facts.dimension ||
      (attribute.default_unit_code != null && attribute.default_unit_code !== canonical.code)) {
    return { error: 'invalid_catalog' };
  }
  return { facts, canonical };
}

function validDependencyReferences(
  model: JournalCaptureCatalogModel,
  layout: JournalLayoutDefinition,
): boolean {
  if (hasChoiceDependencyCycle(layout.option_dependencies)) return false;
  const targetKinds = new Map<string, 'choices' | 'units'>();
  for (const dependency of layout.option_dependencies) {
    const source = dependency.when.attribute_code;
    if (source === 'activity_code') {
      if (model.vocabByCode.get(dependency.when.equals)?.kind !== 'activity') return false;
    } else {
      const sourceAttribute = model.vocabByCode.get(source);
      const sourceChoice = model.vocabByCode.get(dependency.when.equals);
      if (!sourceAttribute || sourceAttribute.kind !== 'attribute' || sourceAttribute.value_type !== 'choice' ||
          !sourceChoice || sourceChoice.kind !== 'choice' || sourceChoice.parent_code !== source) return false;
    }
    const target = model.vocabByCode.get(dependency.restrict.attribute_code);
    if (!target || target.kind !== 'attribute') return false;
    const kind = 'choices' in dependency.restrict ? 'choices' : 'units';
    if (targetKinds.has(target.code) && targetKinds.get(target.code) !== kind) return false;
    targetKinds.set(target.code, kind);
    if (kind === 'choices') {
      if (target.value_type !== 'choice') return false;
      if (!(dependency.restrict as { choices: string[] }).choices.every((code) => {
        const choice = model.vocabByCode.get(code);
        return choice?.kind === 'choice' && choice.parent_code === target.code && isActive(choice);
      })) return false;
    } else {
      if (!numericAttributeValid(target)) return false;
      if (!(dependency.restrict as { units: string[] }).units.every((code) =>
        !('error' in validUnitForAttribute(model, target, code)))) return false;
    }
  }
  return true;
}

function parseLayout(
  row: JournalDefinitionRow,
  domain: DefinitionDomain,
  templates: Map<string, JournalTemplateDefinition>,
): JournalLayoutDefinition | null {
  if (row.catalog_errors.includes('definition_json') || !isRecord(row.definition)) return null;
  const definition = row.definition;
  const activityCodes = stringArray(definition.activity_codes);
  const supportedTemplates = stringArray(definition.supported_templates);
  const dependencies = parseDependencies(definition.option_dependencies);
  if (!activityCodes || !supportedTemplates || !dependencies ||
      activityCodes.some((code) => domain.vocabByCode.get(code)?.kind !== 'activity') ||
      supportedTemplates.some((code) => !templates.has(code))) return null;
  const fields = definition.fields == null ? [] : definition.fields;
  const minimumFields = definition.minimum_fields == null ? [] : stringArray(definition.minimum_fields);
  const denominatorContract = definition.denominator_contract == null
    ? []
    : stringArray(definition.denominator_contract);
  const conditionalFields = parseConditionalFields(
    definition.conditional_fields,
    domain.vocabByCode,
  );
  if (!validFields(fields, domain) || !minimumFields || !denominatorContract ||
      minimumFields.some((code) => !knownField(domain.vocabByCode, code)) ||
      !conditionalFields) return null;
  return {
    code: row.code,
    version: row.version,
    activity_codes: activityCodes,
    supported_templates: supportedTemplates,
    fields: [...fields],
    minimum_fields: minimumFields,
    conditional_fields: conditionalFields,
    denominator_contract: denominatorContract,
    option_dependencies: dependencies,
  };
}

export function catalogLabel(
  row: Pick<JournalVocabRow | JournalDefinitionRow, 'code' | 'labels'>,
  locale: string,
): string {
  return row.labels?.[locale] ?? row.labels?.en ?? row.code;
}

export function activeDefinition(
  rows: JournalDefinitionRow[],
  code: string,
): JournalDefinitionRow | undefined {
  return rows
    .filter((row) => row.code === code && row.active === 1)
    .sort((left, right) => right.version - left.version)[0];
}

export function buildCatalogModel(catalog: JournalCatalog): CatalogModelResult {
  const errors: string[] = [];
  const vocabByCode = new Map<string, JournalVocabRow>();
  for (const row of catalog.vocab) {
    if (vocabByCode.has(row.code)) errors.push(`duplicate vocab code: ${row.code}`);
    vocabByCode.set(row.code, row);
  }
  const templateCodes = new Set(
    catalog.templates.filter((row) => row.active === 1).map((row) => row.code),
  );
  const layoutCodes = new Set(
    catalog.layouts.filter((row) => row.active === 1).map((row) => row.code),
  );
  const domain = { vocabByCode, templateCodes, layoutCodes };
  const templates = new Map<string, JournalTemplateDefinition>();
  for (const code of [...new Set(catalog.templates.map((row) => row.code))]) {
    const row = activeDefinition(catalog.templates, code);
    const parsed = row && parseTemplate(row, domain);
    if (!parsed) errors.push(`invalid template definition: ${code}`);
    else templates.set(code, parsed);
  }
  const layouts = new Map<string, JournalLayoutDefinition>();
  for (const code of [...new Set(catalog.layouts.map((row) => row.code))]) {
    const row = activeDefinition(catalog.layouts, code);
    const parsed = row && parseLayout(row, domain, templates);
    if (!parsed) errors.push(`invalid layout definition: ${code}`);
    else layouts.set(code, parsed);
  }
  const model = { vocabByCode, templates, layouts };
  for (const layout of layouts.values()) {
    if (!validDependencyReferences(model, layout)) {
      errors.push(`invalid option dependencies: ${layout.code}`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, model };
}

function selectedValues(selections: JournalSelections, code: string): JournalScalarValue[] {
  const raw = selections[code];
  if (raw === undefined) return [];
  return (Array.isArray(raw) ? raw : [raw]).filter(isScalarValue);
}

type JournalScalarValue = string | number | boolean | null;

function isScalarValue(value: unknown): value is JournalScalarValue {
  return value == null || typeof value === 'string' || typeof value === 'number' ||
    typeof value === 'boolean';
}

function resolveDependencies(
  layout: JournalLayoutDefinition,
  selections: JournalSelections,
): Map<string, { choices: string[]; units: string[] }> {
  const targets = new Map<string, { choices: string[]; units: string[] }>();
  for (const dependency of layout.option_dependencies) {
    if (!targets.has(dependency.restrict.attribute_code)) {
      targets.set(dependency.restrict.attribute_code, { choices: [], units: [] });
    }
  }
  const targetCodes = new Set(targets.keys());
  const validated = new Map<string, Set<JournalScalarValue>>();
  for (const [code] of Object.entries(selections)) {
    if (!targetCodes.has(code)) validated.set(code, new Set(selectedValues(selections, code)));
  }
  for (let attempt = 0; attempt <= layout.option_dependencies.length + 1; attempt += 1) {
    let changed = false;
    for (const dependency of layout.option_dependencies) {
      if (!validated.get(dependency.when.attribute_code)?.has(dependency.when.equals)) continue;
      const resolved = targets.get(dependency.restrict.attribute_code);
      if (!resolved) continue;
      const values = 'choices' in dependency.restrict
        ? dependency.restrict.choices
        : dependency.restrict.units;
      const target = 'choices' in dependency.restrict ? resolved.choices : resolved.units;
      for (const value of values) {
        if (!target.includes(value)) {
          target.push(value);
          changed = true;
        }
      }
    }
    for (const [targetCode, resolved] of targets) {
      const chosen = selectedValues(selections, targetCode);
      if (chosen.length === 0 || resolved.choices.length === 0) continue;
      const accepted = validated.get(targetCode) ?? new Set<JournalScalarValue>();
      for (const value of chosen) {
        if (typeof value === 'string' && resolved.choices.includes(value) && !accepted.has(value)) {
          accepted.add(value);
          changed = true;
        }
      }
      validated.set(targetCode, accepted);
    }
    if (!changed) break;
  }
  return targets;
}

export function allowedChoices(
  model: JournalCaptureCatalogModel,
  layout: JournalLayoutDefinition,
  attributeCode: string,
  selections: JournalSelections,
): string[] {
  const attribute = model.vocabByCode.get(attributeCode);
  if (!attribute || attribute.kind !== 'attribute' || attribute.value_type !== 'choice') return [];
  const resolved = resolveDependencies(layout, selections);
  if (resolved.has(attributeCode)) return [...(resolved.get(attributeCode)?.choices ?? [])];
  return [...model.vocabByCode.values()]
    .filter((row) => row.kind === 'choice' && row.parent_code === attributeCode && isActive(row))
    .sort((left, right) => left.sort_order - right.sort_order || left.code.localeCompare(right.code))
    .map((row) => row.code);
}

export function allowedUnits(
  model: JournalCaptureCatalogModel,
  layout: JournalLayoutDefinition,
  attributeCode: string,
  selections: JournalSelections,
): string[] {
  const attribute = model.vocabByCode.get(attributeCode);
  if (!attribute || !numericAttributeValid(attribute)) return [];
  const compatible = [...model.vocabByCode.values()]
    .filter((row) => row.kind === 'unit' && isActive(row))
    .filter((row) => !('error' in validUnitForAttribute(model, attribute, row.code)))
    .map((row) => row.code)
    .sort();
  const resolved = resolveDependencies(layout, selections);
  if (!resolved.has(attributeCode)) return compatible;
  const restricted = new Set(resolved.get(attributeCode)?.units ?? []);
  return compatible.filter((code) => restricted.has(code));
}

export function convertNumericValue(
  model: JournalCaptureCatalogModel,
  attributeCode: string,
  enteredValue: number,
  enteredUnitCode: string,
): NumericConversionResult {
  if (!Number.isFinite(enteredValue)) return { ok: false, code: 'invalid_number' };
  const attribute = model.vocabByCode.get(attributeCode);
  if (!attribute || !numericAttributeValid(attribute)) return { ok: false, code: 'invalid_catalog' };
  const conversion = validUnitForAttribute(model, attribute, enteredUnitCode);
  if ('error' in conversion) return { ok: false, code: conversion.error };
  let canonicalValue = enteredValue * conversion.facts.scale + conversion.facts.offset;
  if (!Number.isFinite(canonicalValue)) return { ok: false, code: 'invalid_number' };
  if (canonicalValue === 0) canonicalValue = 0;
  return {
    value_num: canonicalValue,
    unit_code: conversion.canonical.code,
    entered_value_num: enteredValue,
    entered_unit_code: enteredUnitCode,
  };
}

export function isLayoutTemplateCompatible(
  layout: JournalLayoutDefinition | undefined,
  template: JournalTemplateDefinition | undefined,
): boolean {
  return Boolean(layout && template && layout.supported_templates.includes(template.code));
}

function leafKey(leaf: ActivityLeafSelection): string {
  return JSON.stringify([leaf.activity_code, ...leaf.dependent_selections.map((selection) => [
    selection.attribute_code,
    selection.value,
  ])]);
}

export function deriveActivityLeaves(
  model: JournalCaptureCatalogModel,
  layout: JournalLayoutDefinition,
): ActivityLeafSelection[] {
  const choiceTargets = layout.option_dependencies
    .filter((dependency) => 'choices' in dependency.restrict)
    .map((dependency) => dependency.restrict.attribute_code)
    .filter((code, index, all) => all.indexOf(code) === index);
  const leaves: ActivityLeafSelection[] = [];
  const expand = (activityCode: string, dependentSelections: ActivityLeafSelection['dependent_selections']) => {
    const selections: JournalSelections = { activity_code: activityCode };
    for (const selection of dependentSelections) selections[selection.attribute_code] = selection.value;
    const nextTarget = choiceTargets.find((target) => {
      if (dependentSelections.some((selection) => selection.attribute_code === target)) return false;
      return allowedChoices(model, layout, target, selections).length > 0;
    });
    if (!nextTarget) {
      leaves.push({ activity_code: activityCode, dependent_selections: dependentSelections });
      return;
    }
    for (const value of allowedChoices(model, layout, nextTarget, selections)) {
      expand(activityCode, [...dependentSelections, { attribute_code: nextTarget, value }]);
    }
  };
  for (const activityCode of layout.activity_codes) {
    const activity = model.vocabByCode.get(activityCode);
    if (activity?.kind === 'activity' && isActive(activity)) expand(activityCode, []);
  }
  const seen = new Set<string>();
  return leaves.filter((leaf) => {
    const key = leafKey(leaf);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
