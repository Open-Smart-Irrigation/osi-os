'use strict';

const { aggregateHash, buildAggregate } = require('./aggregate');
const { buildContext } = require('./context');
const { loadCatalog } = require('./catalog');
const journalApi = require('./api');
const {
  dependencyCatalogErrors,
  resolveOptions,
  validateSelections,
} = require('./cascade');
const {
  definitionFieldRules,
  isCalendarDate,
  predicateResult,
  semanticDefinitionErrors,
} = require('./definition');
const {
  allowedUnits,
  convertToCanonical,
  normalizeMissingUnits,
  numericAttributePreflight,
  numericStepMatches,
  validateFrozenUnitMetadata,
} = require('./units');

const CUSTOM_CODE = /^custom\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function errorResult(field, code, message) {
  return { ok: false, errors: [{ field, code, message }] };
}

function requiredErrors(requirement, present) {
  const errors = [];
  for (const field of (requirement && requirement.required) || []) {
    if (!present.has(field)) {
      errors.push({ field, code: 'required', message: 'Required field is missing' });
    }
  }
  for (const alternatives of (requirement && requirement.required_any) || []) {
    if (!alternatives.some(function(field) { return present.has(field); })) {
      errors.push({
        field: alternatives.join('|'),
        code: 'required',
        message: 'At least one of these fields is required',
      });
    }
  }
  return errors;
}

function isSemanticallyPresentValue(value) {
  if (!value || value.value_status !== 'observed' || value.value == null) return false;
  return typeof value.value !== 'string' || value.value.trim() !== '';
}

function requiredGroupErrors(requirement, values) {
  const families = (requirement && requirement.required_any) || [];
  if (families.length < 2) return [];
  const familyCodes = new Set(families.flat());
  const groups = new Map();
  for (const value of values) {
    if (!familyCodes.has(value.attribute_code)) continue;
    if (!groups.has(value.group_index)) groups.set(value.group_index, []);
    groups.get(value.group_index).push(value);
  }
  const errors = [];
  for (const [groupIndex, groupValues] of groups) {
    for (const alternatives of families) {
      const satisfied = groupValues.some(function(value) {
        return alternatives.includes(value.attribute_code) && isSemanticallyPresentValue(value);
      });
      if (!satisfied) {
        errors.push({
          field: 'values[group=' + groupIndex + '].' + alternatives.join('|'),
          code: 'required_in_group',
          message: 'Each repeat group must include every required field family',
        });
      }
    }
  }
  return errors;
}

function jsonBytes(value) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return { ok: false, bytes: 0 };
    return { ok: true, bytes: Buffer.byteLength(encoded, 'utf8') };
  } catch (_) {
    return { ok: false, bytes: 0 };
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function valueShape(attribute, row, valueStatus) {
  const hasGeneric = Boolean(row) && row.value != null;
  const hasNumber = Boolean(row) && row.value_num != null;
  const hasText = Boolean(row) && row.value_text != null;
  const hasEnteredNumber = Boolean(row) && row.entered_value_num != null;
  const hasUnit = Boolean(row) && row.unit_code != null;
  const hasEnteredUnit = Boolean(row) && row.entered_unit_code != null;
  if (valueStatus !== 'observed') {
    if (attribute.value_type !== 'number' && (hasUnit || hasEnteredUnit)) return { ok: false };
    return hasGeneric || hasNumber || hasText || hasEnteredNumber
      ? { ok: false }
      : { ok: true, value: null };
  }
  if (attribute.value_type !== 'number' &&
      (hasUnit || hasEnteredUnit || hasEnteredNumber)) {
    return { ok: false };
  }
  const numberBacked = attribute.value_type === 'number' || attribute.value_type === 'boolean';
  if ((numberBacked && hasText) || (!numberBacked && hasNumber)) return { ok: false };

  let hasTyped = false;
  let typedValue;
  if (attribute.value_type === 'number' && hasNumber) {
    if (typeof row.value_num !== 'number' || !Number.isFinite(row.value_num)) return { ok: false };
    hasTyped = true;
    typedValue = row.value_num;
  } else if (attribute.value_type === 'boolean' && hasNumber) {
    if (row.value_num !== 0 && row.value_num !== 1) return { ok: false };
    hasTyped = true;
    typedValue = row.value_num === 1;
  } else if (['text', 'choice', 'date'].includes(attribute.value_type) && hasText) {
    if (typeof row.value_text !== 'string') return { ok: false };
    hasTyped = true;
    typedValue = row.value_text;
  }
  if (hasGeneric && hasTyped && !Object.is(row.value, typedValue)) return { ok: false };
  return { ok: true, value: hasGeneric ? row.value : typedValue };
}

function numericNormalization(catalog, attribute, row, semanticValue) {
  const hasEnteredValue = row.entered_value_num != null;
  const hasEnteredUnit = row.entered_unit_code != null;
  if (hasEnteredValue !== hasEnteredUnit) return { ok: false, code: 'invalid_value_shape' };

  let enteredValue = semanticValue;
  let enteredUnit = row.unit_code;
  if (hasEnteredValue) {
    if (typeof row.entered_value_num !== 'number' || !Number.isFinite(row.entered_value_num) ||
        typeof row.entered_unit_code !== 'string' || !row.entered_unit_code ||
        typeof row.value_num !== 'number' || !Number.isFinite(row.value_num) ||
        typeof row.unit_code !== 'string' || !row.unit_code) {
      return { ok: false, code: 'invalid_value_shape' };
    }
    enteredValue = row.entered_value_num;
    enteredUnit = row.entered_unit_code;
  } else if (enteredUnit == null) {
    if (attribute.constraints.requires_explicit_unit === true ||
        attribute.constraints.allow_default_unit === false ||
        typeof attribute.default_unit_code !== 'string' || !attribute.default_unit_code) {
      return { ok: false, code: 'unit_required' };
    }
    enteredUnit = attribute.default_unit_code;
  }

  const converted = convertToCanonical(
    catalog,
    attribute.code,
    enteredValue,
    enteredUnit
  );
  if (!converted.ok) return converted;
  if (hasEnteredValue &&
      (!Object.is(converted.value_num, semanticValue) || converted.unit_code !== row.unit_code)) {
    return { ok: false, code: 'invalid_value_shape' };
  }
  return {
    ok: true,
    value_num: converted.value_num,
    unit_code: converted.unit_code,
    entered_value_num: enteredValue,
    entered_unit_code: enteredUnit,
  };
}

function numericUnitError(index, failure) {
  const field = failure.code === 'invalid_value_shape'
    ? 'values[' + index + ']'
    : failure.code === 'invalid_number'
      ? 'values[' + index + '].value'
      : failure.code === 'invalid_catalog' || failure.code === 'inactive_attribute'
        ? 'values[' + index + '].attribute_code'
        : 'values[' + index + '].unit_code';
  const message = failure.code === 'unit_required'
    ? 'An explicit unit is required for this numeric value'
    : failure.code === 'invalid_value_shape'
      ? 'Canonical and entered numeric representations are contradictory'
      : 'Numeric unit validation failed';
  return errorResult(field, failure.code, message);
}

function hasRetiredNumericTerm(catalog, attribute, row) {
  if (attribute.active !== 1 || attribute.deleted_at) return true;
  for (const code of [row.unit_code, row.entered_unit_code]) {
    if (code == null) continue;
    const unit = catalog.vocabByCode.get(code);
    if (unit && unit.kind === 'unit' && (unit.active !== 1 || unit.deleted_at)) return true;
  }
  return false;
}

function logicalValueRow(row, attribute) {
  const valueStatus = row && row.value_status != null ? row.value_status : 'observed';
  const shape = valueShape(attribute, row, valueStatus);
  return {
    valid: shape.ok,
    attribute_code: row && row.attribute_code,
    group_index: row && row.group_index != null ? row.group_index : 0,
    value: shape.value,
    value_status: valueStatus,
    unit_code: row && row.unit_code != null ? row.unit_code : null,
    entered_value_num: row && row.entered_value_num != null ? row.entered_value_num : null,
    entered_unit_code: row && row.entered_unit_code != null ? row.entered_unit_code : null,
  };
}

function sameLogicalValue(catalog, left, right) {
  const attributeCode = left && left.attribute_code;
  if (!right || right.attribute_code !== attributeCode) return false;
  const attribute = catalog.vocabByCode.get(attributeCode);
  if (!attribute || attribute.kind !== 'attribute') return false;
  const a = logicalValueRow(left, attribute);
  const b = logicalValueRow(right, attribute);
  return a.valid && b.valid &&
    a.attribute_code === b.attribute_code &&
    a.group_index === b.group_index &&
    Object.is(a.value, b.value) &&
    a.value_status === b.value_status &&
    a.unit_code === b.unit_code &&
    Object.is(a.entered_value_num, b.entered_value_num) &&
    a.entered_unit_code === b.entered_unit_code;
}

function preservedOriginalValue(catalog, originalEntry, value) {
  return originalEntry.values.some(function(originalValue) {
    return sameLogicalValue(catalog, originalValue, value);
  });
}

function referenceValueSet(validationContext, key) {
  const referenceValues = validationContext.referenceValues;
  let allowed;
  if (referenceValues instanceof Map) allowed = referenceValues.get(key);
  else if (isPlainObject(referenceValues) &&
           Object.prototype.hasOwnProperty.call(referenceValues, key)) allowed = referenceValues[key];
  else if (referenceValues != null && !isPlainObject(referenceValues)) {
    return { ok: false, code: 'invalid_context' };
  }
  if (allowed == null) return { ok: true, resolved: false };
  if (!(allowed instanceof Set) && !Array.isArray(allowed)) {
    return { ok: false, code: 'invalid_context' };
  }
  return { ok: true, resolved: true, allowed };
}

function originalReferenceRetirement(catalog, attribute, logical, validationContext) {
  if (logical.value_status !== 'observed' || attribute.constraints.reference == null) {
    return { invalid: false, retired: false };
  }
  const reference = attribute.constraints.reference;
  if (!isPlainObject(reference) || typeof reference.table !== 'string' ||
      typeof reference.column !== 'string' || !reference.table || !reference.column) {
    return { invalid: true, retired: false, code: 'invalid_catalog' };
  }
  const key = reference.table + '.' + reference.column;
  if (key === 'journal_products.product_uuid') {
    if (!(catalog.products instanceof Map)) {
      return { invalid: true, retired: false, code: 'invalid_catalog' };
    }
    const product = catalog.products.get(logical.value);
    if (!product) return { invalid: true, retired: false, code: 'invalid_catalog' };
    return {
      invalid: false,
      retired: product.active !== 1 || Boolean(product.deleted_at),
    };
  }
  const resolved = referenceValueSet(validationContext, key);
  if (!resolved.ok) return { invalid: true, retired: false, code: resolved.code };
  if (!resolved.resolved) return { invalid: false, retired: true };
  const found = resolved.allowed instanceof Set
    ? resolved.allowed.has(logical.value)
    : resolved.allowed.includes(logical.value);
  return { invalid: false, retired: !found };
}

function originalValueRetirement(catalog, originalValue, validationContext) {
  const attribute = catalog.vocabByCode.get(originalValue.attribute_code);
  if (!attribute || attribute.kind !== 'attribute' ||
      !['number', 'text', 'choice', 'date', 'boolean'].includes(attribute.value_type)) {
    return { invalid: true, retired: false, code: 'invalid_catalog' };
  }
  let retired = attribute.active !== 1 || Boolean(attribute.deleted_at);
  const logical = logicalValueRow(originalValue, attribute);
  if (!logical.valid) return { invalid: true, retired: false, code: 'invalid_catalog' };
  if (logical.value_status === 'observed' && attribute.value_type === 'choice') {
    const choice = catalog.vocabByCode.get(logical.value);
    if (!choice || choice.kind !== 'choice' || choice.parent_code !== attribute.code) {
      return { invalid: true, retired: false, code: 'invalid_catalog' };
    }
    retired = retired || choice.active !== 1 || Boolean(choice.deleted_at);
  }
  for (const unitCode of [logical.unit_code, logical.entered_unit_code]) {
    if (unitCode == null) continue;
    const unit = catalog.vocabByCode.get(unitCode);
    if (!unit || unit.kind !== 'unit') {
      return { invalid: true, retired: false, code: 'invalid_catalog' };
    }
    retired = retired || unit.active !== 1 || Boolean(unit.deleted_at);
  }
  if (!attribute.constraints || typeof attribute.constraints !== 'object' ||
      Array.isArray(attribute.constraints)) {
    return { invalid: true, retired: false, code: 'invalid_catalog' };
  }
  const reference = originalReferenceRetirement(
    catalog,
    attribute,
    logical,
    validationContext
  );
  if (reference.invalid) return reference;
  retired = retired || reference.retired;
  return { invalid: false, retired };
}

function correctionPreservationErrors(catalog, originalEntry, normalizedValues, validationContext) {
  const errors = [];
  for (const originalValue of originalEntry.values) {
    const retirement = originalValueRetirement(catalog, originalValue, validationContext);
    if (retirement.invalid) {
      const contextError = retirement.code === 'invalid_context';
      errors.push({
        field: contextError
          ? 'validationContext.referenceValues'
          : 'validationContext.originalEntry.values',
        code: contextError ? 'invalid_context' : 'invalid_catalog',
        message: contextError
          ? 'Reference resolver context is invalid'
          : 'Original value references missing or corrupt vocabulary',
      });
      continue;
    }
    if (retirement.retired && !normalizedValues.some(function(value) {
      return sameLogicalValue(catalog, originalValue, value);
    })) {
      errors.push({
        field: 'values.' + originalValue.attribute_code,
        code: 'inactive_value_omitted',
        message: 'Correction must preserve every original inactive value row exactly',
      });
    }
  }
  return errors;
}

function correctionContextErrors(validationContext, entryInput, layoutDef, templateDef) {
  if (!isPlainObject(validationContext)) {
    return [{ field: 'validationContext', code: 'invalid_context', message: 'Validation context must be an object' }];
  }
  const mode = validationContext.mode == null ? 'create' : validationContext.mode;
  if (!['create', 'correction'].includes(mode)) {
    return [{ field: 'validationContext.mode', code: 'invalid_context', message: 'Validation mode is not supported' }];
  }
  if (mode !== 'correction') return [];
  const original = validationContext.originalEntry;
  if (!isPlainObject(original) || !Array.isArray(original.values)) {
    return [{
      field: 'validationContext.originalEntry',
      code: 'correction_context_required',
      message: 'Correction validation requires the original entry aggregate',
    }];
  }
  const submittedTemplateVersion = entryInput.template_version == null
    ? templateDef && templateDef.version
    : entryInput.template_version;
  const submittedLayoutVersion = entryInput.layout_version == null
    ? layoutDef && layoutDef.version
    : entryInput.layout_version;
  const pinsMatch = original.activity_code === entryInput.activity_code &&
    original.template_code === entryInput.template_code &&
    original.template_version === submittedTemplateVersion &&
    original.layout_code === entryInput.layout_code &&
    original.layout_version === submittedLayoutVersion;
  return pinsMatch ? [] : [{
    field: 'validationContext.originalEntry',
    code: 'correction_pin_mismatch',
    message: 'Correction must preserve the original activity, template, and layout pins',
  }];
}

function referenceError(catalog, constraints, value, validationContext, preservedHistoricalValue) {
  const reference = constraints.reference;
  if (reference == null) return null;
  if (!isPlainObject(reference) || typeof reference.table !== 'string' ||
      typeof reference.column !== 'string' || !reference.table || !reference.column) {
    return { code: 'invalid_catalog', message: 'Attribute reference constraint is invalid' };
  }
  const key = reference.table + '.' + reference.column;
  if (key === 'journal_products.product_uuid') {
    if (!(catalog.products instanceof Map)) {
      return { code: 'invalid_catalog', message: 'Product catalog is invalid' };
    }
    const product = catalog.products.get(value);
    if (product && product.active === 1 && !product.deleted_at) return null;
    if (product && preservedHistoricalValue) return null;
    return { code: 'invalid_reference', message: 'Product reference is unknown or inactive' };
  }
  const resolved = referenceValueSet(validationContext, key);
  if (!resolved.ok) {
    return { code: 'invalid_context', message: 'referenceValues must be a Map or object' };
  }
  if (!resolved.resolved) {
    if (preservedHistoricalValue) return null;
    return { code: 'reference_unresolved', message: 'No resolver was supplied for this reference' };
  }
  const found = resolved.allowed instanceof Set
    ? resolved.allowed.has(value)
    : resolved.allowed.includes(value);
  if (found || preservedHistoricalValue) return null;
  return { code: 'invalid_reference', message: 'Reference value does not exist' };
}

function missingCustomDependency(catalog, field, code) {
  const vocab = catalog && catalog.vocabByCode;
  const knownCustomCodes = catalog && catalog.knownCustomCodes;
  if (!(vocab instanceof Map) || typeof code !== 'string' ||
      !CUSTOM_CODE.test(code) || vocab.has(code) ||
      (knownCustomCodes instanceof Set && knownCustomCodes.has(code))) {
    return null;
  }
  return {
    ok: false,
    errors: [{
      field,
      code: 'missing_custom_dependency',
      message: 'Custom vocabulary dependency is not installed',
      dependency_code: code,
    }],
  };
}

function validateEntry(catalog, _layoutDef, _templateDef, entryInput, validationContext) {
  if (!entryInput || typeof entryInput !== 'object' || Array.isArray(entryInput)) {
    return errorResult('entry', 'invalid_type', 'Entry must be an object');
  }
  const requestSize = jsonBytes(entryInput);
  if (!requestSize.ok) {
    return errorResult('entry', 'invalid_json', 'Entry must be JSON-serializable');
  }
  if (requestSize.bytes > 256 * 1024) {
    return errorResult('entry', 'limit_exceeded', 'Entry exceeds the 256 KiB request limit');
  }
  const context = validationContext == null ? {} : validationContext;
  const contextErrors = correctionContextErrors(context, entryInput, _layoutDef, _templateDef);
  if (contextErrors.length) return { ok: false, errors: contextErrors };
  const correction = context.mode === 'correction';
  const originalEntry = correction ? context.originalEntry : null;
  if (entryInput.author_label != null && typeof entryInput.author_label !== 'string') {
    return errorResult('author_label', 'invalid_type', 'Author label must be text');
  }
  if (typeof entryInput.author_label === 'string' &&
      Array.from(entryInput.author_label).length > 120) {
    return errorResult('author_label', 'limit_exceeded', 'Author label exceeds 120 characters');
  }
  if (entryInput.note != null && typeof entryInput.note !== 'string') {
    return errorResult('note', 'invalid_type', 'Note must be text');
  }
  if (typeof entryInput.note === 'string' && Array.from(entryInput.note).length > 4000) {
    return errorResult('note', 'limit_exceeded', 'Note exceeds the 4000 character limit');
  }
  for (const field of ['context', 'context_json']) {
    if (entryInput[field] == null) continue;
    let contextValue = entryInput[field];
    if (field === 'context_json' && typeof contextValue === 'string') {
      if (Buffer.byteLength(contextValue, 'utf8') > 64 * 1024) {
        return errorResult(field, 'limit_exceeded', 'Context exceeds the 64 KiB limit');
      }
      try {
        contextValue = JSON.parse(contextValue);
      } catch (_) {
        return errorResult(field, 'invalid_json', 'Context must contain valid JSON');
      }
    }
    const contextSize = jsonBytes(contextValue);
    if (!contextSize.ok) return errorResult(field, 'invalid_json', 'Context must be JSON-serializable');
    if (contextSize.bytes > 64 * 1024) {
      return errorResult(field, 'limit_exceeded', 'Context exceeds the 64 KiB limit');
    }
  }
  const activity = catalog && catalog.vocabByCode instanceof Map
    ? catalog.vocabByCode.get(entryInput.activity_code)
    : null;
  if (!activity || activity.kind !== 'activity') {
    const missingDependency = missingCustomDependency(
      catalog,
      'activity_code',
      entryInput.activity_code
    );
    if (missingDependency) return missingDependency;
    return errorResult('activity_code', 'unknown_code', 'Unknown activity code');
  }
  if ((activity.active !== 1 || activity.deleted_at) && !correction) {
    return errorResult('activity_code', 'inactive_term', 'Activity code is inactive');
  }
  const compatibilityErrors = [];
  const layoutDefinition = _layoutDef && _layoutDef.definition;
  const templateDefinition = _templateDef && _templateDef.definition;
  const semanticErrors = [];
  if (_layoutDef && layoutDefinition &&
      !(_layoutDef.catalog_errors || []).includes('definition_json')) {
    semanticErrors.push(...semanticDefinitionErrors(catalog, layoutDefinition, 'layout_definition'));
    semanticErrors.push(...dependencyCatalogErrors(
      catalog,
      layoutDefinition,
      'layout_definition.option_dependencies',
      { allowInactive: correction }
    ));
  }
  if (_templateDef && templateDefinition &&
      !(_templateDef.catalog_errors || []).includes('definition_json')) {
    semanticErrors.push(...semanticDefinitionErrors(catalog, templateDefinition, 'template_definition'));
  }
  if (semanticErrors.length) return { ok: false, errors: semanticErrors };
  if (!_layoutDef || !layoutDefinition || typeof layoutDefinition !== 'object' ||
      (_layoutDef.catalog_errors || []).includes('definition_json')) {
    compatibilityErrors.push({
      field: 'layout_code', code: 'invalid_catalog', message: 'Layout definition is invalid',
    });
  } else {
    if ((_layoutDef.active !== 1 || _layoutDef.deleted_at) && !correction) {
      compatibilityErrors.push({
        field: 'layout_code', code: 'inactive_definition', message: 'Layout definition is inactive',
      });
    }
    if (_layoutDef.code && _layoutDef.code !== entryInput.layout_code) {
      compatibilityErrors.push({
        field: 'layout_code', code: 'definition_mismatch', message: 'Layout does not match its definition',
      });
    }
    if (entryInput.layout_version != null && _layoutDef.version !== entryInput.layout_version) {
      compatibilityErrors.push({
        field: 'layout_version', code: 'definition_mismatch', message: 'Layout version does not match',
      });
    }
    if (Array.isArray(layoutDefinition.activity_codes) &&
        !layoutDefinition.activity_codes.includes(entryInput.activity_code)) {
      compatibilityErrors.push({
        field: 'activity_code', code: 'not_supported', message: 'Activity is not supported by this layout',
      });
    }
    if (Array.isArray(layoutDefinition.supported_templates) &&
        !layoutDefinition.supported_templates.includes(entryInput.template_code)) {
      compatibilityErrors.push({
        field: 'template_code', code: 'not_supported', message: 'Template is not supported by this layout',
      });
    }
  }
  if (!_templateDef || !templateDefinition || typeof templateDefinition !== 'object' ||
      (_templateDef.catalog_errors || []).includes('definition_json')) {
    compatibilityErrors.push({
      field: 'template_code', code: 'invalid_catalog', message: 'Template definition is invalid',
    });
  } else {
    if ((_templateDef.active !== 1 || _templateDef.deleted_at) && !correction) {
      compatibilityErrors.push({
        field: 'template_code', code: 'inactive_definition', message: 'Template definition is inactive',
      });
    }
    if (_templateDef.code && _templateDef.code !== entryInput.template_code) {
      compatibilityErrors.push({
        field: 'template_code', code: 'definition_mismatch', message: 'Template does not match its definition',
      });
    }
  }
  if (_templateDef && templateDefinition && entryInput.template_version != null &&
      _templateDef.version !== entryInput.template_version) {
    compatibilityErrors.push({
      field: 'template_version', code: 'definition_mismatch', message: 'Template version does not match',
    });
  }
  if (compatibilityErrors.length) return { ok: false, errors: compatibilityErrors };
  if (!Array.isArray(entryInput.values)) {
    return errorResult('values', 'invalid_type', 'Values must be an array');
  }
  if (entryInput.values.length > 128) {
    return errorResult('values', 'limit_exceeded', 'Entry exceeds the 128 value limit');
  }
  const values = entryInput.values;
  const normalizedValues = [];
  const groups = new Set();
  const valueKeys = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return errorResult('values[' + index + ']', 'invalid_type', 'Value must be an object');
    }
    const groupIndex = value.group_index == null ? 0 : value.group_index;
    if (!Number.isInteger(groupIndex) || groupIndex < 0) {
      return errorResult(
        'values[' + index + '].group_index',
        'invalid_group',
        'Group index must be a nonnegative integer'
      );
    }
    groups.add(groupIndex);
    if (groups.size > 32) {
      return errorResult('values', 'limit_exceeded', 'Entry exceeds the 32 group limit');
    }
    const valueKey = String(groupIndex) + '\u0000' + String(value.attribute_code || '');
    if (valueKeys.has(valueKey)) {
      return errorResult(
        'values[' + index + '].attribute_code',
        'duplicate_value',
        'Attribute is duplicated in this group'
      );
    }
    valueKeys.add(valueKey);
    const valueStatus = value.value_status == null ? 'observed' : value.value_status;
    if (!['observed', 'not_observed', 'not_applicable', 'below_detection'].includes(valueStatus)) {
      return errorResult(
        'values[' + index + '].value_status',
        'invalid_status',
        'Value status is not supported'
      );
    }
    const attribute = value && catalog.vocabByCode.get(value.attribute_code);
    if (!attribute || attribute.kind !== 'attribute') {
      const missingDependency = missingCustomDependency(
        catalog,
        'values[' + index + '].attribute_code',
        value.attribute_code
      );
      if (missingDependency) return missingDependency;
      return errorResult(
        'values[' + index + '].attribute_code',
        'unknown_code',
        'Unknown attribute code'
      );
    }
    const shape = valueShape(attribute, value, valueStatus);
    if (!shape.ok) {
      return errorResult(
        'values[' + index + ']',
        'invalid_value_shape',
        'Generic and typed value representations are contradictory'
      );
    }
    let semanticValue = shape.value;
    const normalizedValue = Object.assign({}, value, {
      group_index: groupIndex,
      value_status: valueStatus,
    });
    if (valueStatus === 'observed' && normalizedValue.value == null && semanticValue !== undefined) {
      normalizedValue.value = semanticValue;
    }
    const valuePreserved = correction && preservedOriginalValue(
      catalog,
      originalEntry,
      normalizedValue
    );
    if (attribute.active !== 1 || attribute.deleted_at) {
      if (!correction) {
        return errorResult(
          'values[' + index + '].attribute_code', 'inactive_term', 'Attribute code is inactive'
        );
      }
      if (!valuePreserved) {
        return errorResult(
          'values[' + index + ']',
          'inactive_value_changed',
          'An inactive value row may only be preserved exactly during correction'
        );
      }
    }
    if ((attribute.catalog_errors || []).includes('constraints_json') ||
        !attribute.constraints || typeof attribute.constraints !== 'object' ||
        Array.isArray(attribute.constraints)) {
      return errorResult(
        'values[' + index + '].attribute_code',
        'invalid_catalog',
        'Attribute constraints are invalid'
      );
    }
    if (attribute.value_type === 'number') {
      const preflight = numericAttributePreflight(
        catalog,
        attribute.code,
        { allowInactive: Boolean(valuePreserved) }
      );
      if (!preflight.ok) return numericUnitError(index, preflight);
    }
    if (valueStatus === 'observed') {
      const type = attribute.value_type;
      const validType = (
        (type === 'number' && typeof semanticValue === 'number' && Number.isFinite(semanticValue)) ||
        (type === 'text' && typeof semanticValue === 'string') ||
        (type === 'choice' && typeof semanticValue === 'string') ||
        (type === 'date' && typeof semanticValue === 'string') ||
        (type === 'boolean' && typeof semanticValue === 'boolean')
      );
      if (!validType) {
        return errorResult(
          'values[' + index + '].value',
          'invalid_type',
          'Value does not match the attribute type'
        );
      }
    }
    if (valueStatus === 'observed' && attribute.value_type === 'date' &&
        !isCalendarDate(semanticValue)) {
      return errorResult(
        'values[' + index + '].value',
        'invalid_date',
        'Date value must be a real YYYY-MM-DD calendar date'
      );
    }
    if (valueStatus === 'observed') {
      const invalidReference = referenceError(
        catalog,
        attribute.constraints,
        semanticValue,
        context,
        valuePreserved
      );
      if (invalidReference) {
        return errorResult(
          'values[' + index + '].value',
          invalidReference.code,
          invalidReference.message
        );
      }
    }
    if (valueStatus === 'observed' && attribute.value_type === 'text' &&
        Buffer.byteLength(semanticValue, 'utf8') > 4096) {
      return errorResult(
        'values[' + index + '].value',
        'limit_exceeded',
        'Text value exceeds the 4096 byte limit'
      );
    }
    if (valueStatus === 'observed' && attribute.value_type === 'choice') {
      const choice = catalog.vocabByCode.get(semanticValue);
      if (!choice || choice.kind !== 'choice' || choice.parent_code !== attribute.code) {
        const missingDependency = missingCustomDependency(
          catalog,
          'values[' + index + '].value',
          semanticValue
        );
        if (missingDependency) return missingDependency;
        return errorResult(
          'values[' + index + '].value',
          'invalid_choice',
          'Choice is not valid for this attribute'
        );
      }
      if (choice.active !== 1 || choice.deleted_at) {
        if (!correction) {
          return errorResult('values[' + index + '].value', 'inactive_term', 'Choice is inactive');
        }
        if (!valuePreserved) {
          return errorResult(
            'values[' + index + ']',
            'inactive_value_changed',
            'An inactive value row may only be preserved exactly during correction'
          );
        }
      }
    }
    if (value.unit_code != null) {
      if (typeof value.unit_code !== 'string') {
        return errorResult('values[' + index + '].unit_code', 'invalid_type', 'Unit code must be text');
      }
      const unit = catalog.vocabByCode.get(value.unit_code);
      if (!unit || unit.kind !== 'unit') {
        const missingDependency = missingCustomDependency(
          catalog,
          'values[' + index + '].unit_code',
          value.unit_code
        );
        if (missingDependency) return missingDependency;
        return errorResult('values[' + index + '].unit_code', 'unknown_code', 'Unknown unit code');
      }
      if (unit.active !== 1 || unit.deleted_at) {
        if (!correction) {
          return errorResult('values[' + index + '].unit_code', 'inactive_term', 'Unit is inactive');
        }
        if (!valuePreserved) {
          return errorResult(
            'values[' + index + ']',
            'inactive_value_changed',
            'An inactive value row may only be preserved exactly during correction'
          );
        }
      }
    }
    if (value.entered_unit_code != null) {
      if (typeof value.entered_unit_code !== 'string') {
        return errorResult(
          'values[' + index + '].entered_unit_code',
          'invalid_type',
          'Entered unit code must be text'
        );
      }
      const enteredUnit = catalog.vocabByCode.get(value.entered_unit_code);
      if (!enteredUnit || enteredUnit.kind !== 'unit') {
        const missingDependency = missingCustomDependency(
          catalog,
          'values[' + index + '].entered_unit_code',
          value.entered_unit_code
        );
        if (missingDependency) return missingDependency;
        return errorResult(
          'values[' + index + '].entered_unit_code',
          'unknown_code',
          'Unknown entered unit code'
        );
      }
      if (enteredUnit.active !== 1 || enteredUnit.deleted_at) {
        if (!correction) {
          return errorResult(
            'values[' + index + '].entered_unit_code',
            'inactive_term',
            'Entered unit is inactive'
          );
        }
        if (!valuePreserved) {
          return errorResult(
            'values[' + index + ']',
            'inactive_value_changed',
            'An inactive value row may only be preserved exactly during correction'
          );
        }
      }
    }
    const preserveFrozenNumeric = attribute.value_type === 'number' && valuePreserved &&
      hasRetiredNumericTerm(catalog, attribute, value);
    if (preserveFrozenNumeric) {
      const frozenMetadata = validateFrozenUnitMetadata(catalog, attribute.code, value);
      if (!frozenMetadata.ok) return numericUnitError(index, frozenMetadata);
    }
    if (valueStatus === 'observed' && attribute.value_type === 'number' &&
        !preserveFrozenNumeric) {
      const canonical = numericNormalization(catalog, attribute, value, semanticValue);
      if (!canonical.ok) return numericUnitError(index, canonical);
      semanticValue = canonical.value_num;
      normalizedValue.value = canonical.value_num;
      normalizedValue.value_num = canonical.value_num;
      normalizedValue.unit_code = canonical.unit_code;
      normalizedValue.entered_value_num = canonical.entered_value_num;
      normalizedValue.entered_unit_code = canonical.entered_unit_code;
      delete normalizedValue.value_text;
    }
    if (valueStatus !== 'observed' && attribute.value_type === 'number' &&
        !preserveFrozenNumeric) {
      const missingUnits = normalizeMissingUnits(
        catalog,
        attribute.code,
        value.unit_code,
        value.entered_unit_code
      );
      if (!missingUnits.ok) return numericUnitError(index, missingUnits);
      if (missingUnits.unit_code !== undefined) {
        normalizedValue.unit_code = missingUnits.unit_code;
      }
      if (missingUnits.entered_unit_code !== undefined) {
        normalizedValue.entered_unit_code = missingUnits.entered_unit_code;
      }
    }
    if (valueStatus === 'observed' && attribute.value_type === 'number' &&
        !preserveFrozenNumeric) {
      if (typeof attribute.constraints.min === 'number' && semanticValue < attribute.constraints.min) {
        return errorResult('values[' + index + '].value', 'below_minimum', 'Value is below the minimum');
      }
      if (typeof attribute.constraints.max === 'number' && semanticValue > attribute.constraints.max) {
        return errorResult('values[' + index + '].value', 'above_maximum', 'Value is above the maximum');
      }
      if (typeof attribute.constraints.step === 'number' && attribute.constraints.step > 0) {
        const base = typeof attribute.constraints.min === 'number' ? attribute.constraints.min : 0;
        if (!numericStepMatches(semanticValue, base, attribute.constraints.step)) {
          return errorResult('values[' + index + '].value', 'step_mismatch', 'Value does not match the step');
        }
      }
    }
    if (valueStatus === 'observed' && typeof semanticValue === 'string' &&
        typeof attribute.constraints.maxlength === 'number' &&
        Array.from(semanticValue).length > attribute.constraints.maxlength) {
      return errorResult(
        'values[' + index + '].value',
        'limit_exceeded',
        'Value exceeds the catalog length limit'
      );
    }
    normalizedValues.push(normalizedValue);
  }
  const cascadeValidation = validateSelections(layoutDefinition, [
    ...normalizedValues,
    { attribute_code: 'activity_code', value: entryInput.activity_code },
  ]);
  if (!cascadeValidation.ok) {
    const cascadeErrors = cascadeValidation.errors.map(function(error) {
      return Object.assign({ message: 'Value is invalid under the selected dependency path' }, error);
    });
    if (cascadeErrors.length) return { ok: false, errors: cascadeErrors };
  }
  if (correction) {
    const preservationErrors = correctionPreservationErrors(
      catalog,
      originalEntry,
      normalizedValues,
      context
    );
    if (preservationErrors.length) return { ok: false, errors: preservationErrors };
  }
  const present = new Set(normalizedValues
    .filter(isSemanticallyPresentValue)
    .map(function(value) { return value.attribute_code; }));
  for (const [field, value] of Object.entries(entryInput)) {
    if (value == null || (typeof value === 'string' && value.trim() === '')) continue;
    present.add(field);
  }
  const definition = templateDefinition;
  const activityRequirements = definition.activity_requirements;
  const requirements = activityRequirements && activityRequirements[entryInput.activity_code];
  const errors = requiredErrors(requirements, present);
  errors.push(...requiredGroupErrors(requirements, normalizedValues));
  for (const group of definition.conditional_groups || []) {
    if (Array.isArray(group.activity_codes) && group.activity_codes.includes(entryInput.activity_code)) {
      errors.push(...requiredErrors(group, present));
      errors.push(...requiredGroupErrors(group, normalizedValues));
    }
  }
  const selections = new Map();
  for (const [field, value] of Object.entries(entryInput)) selections.set(field, [value]);
  for (const value of normalizedValues) {
    if (!isSemanticallyPresentValue(value)) continue;
    if (!selections.has(value.attribute_code)) selections.set(value.attribute_code, []);
    selections.get(value.attribute_code).push(value.value);
  }
  for (const rule of [
    ...definitionFieldRules(definition),
    ...definitionFieldRules(layoutDefinition),
  ]) {
    let visible = true;
    if (rule.visible_if != null) {
      const evaluated = predicateResult(rule.visible_if, selections);
      if (!evaluated.valid) {
        errors.push({
          field: rule.code, code: 'invalid_catalog', message: 'visible_if predicate is invalid',
        });
        continue;
      }
      visible = evaluated.matches;
      if (!visible && present.has(rule.code)) {
        errors.push({
          field: rule.code, code: 'not_visible', message: 'Field is not visible for these selections',
        });
      }
    }
    let required = rule.required === true;
    if (rule.required_if != null) {
      const evaluated = predicateResult(rule.required_if, selections);
      if (!evaluated.valid) {
        errors.push({
          field: rule.code, code: 'invalid_catalog', message: 'required_if predicate is invalid',
        });
        continue;
      }
      required = required || evaluated.matches;
    }
    if (visible && required && !present.has(rule.code)) {
      errors.push({ field: rule.code, code: 'required', message: 'Required field is missing' });
    }
  }
  if (errors.length) return { ok: false, errors };
  const normalized = Object.assign({}, entryInput, { values: normalizedValues });
  const aggregateSize = jsonBytes(normalized);
  if (!aggregateSize.ok) {
    return errorResult('entry', 'invalid_json', 'Normalized entry must be JSON-serializable');
  }
  if (aggregateSize.bytes > 256 * 1024) {
    return errorResult('entry', 'limit_exceeded', 'Normalized entry exceeds the 256 KiB aggregate limit');
  }
  return {
    ok: true,
    normalized,
  };
}

module.exports = {
  aggregateHash,
  applyJournalCommand: function applyJournalCommand() {
    return require('./commands').applyJournalCommand.apply(null, arguments);
  },
  deduplicatePendingCommand: function deduplicatePendingCommand() {
    return require('./commands').deduplicatePendingCommand.apply(null, arguments);
  },
  queueCommandAck: function queueCommandAck() {
    return require('./commands').queueCommandAck.apply(null, arguments);
  },
  validJournalEffectBinding: function validJournalEffectBinding() {
    return require('./commands').validJournalEffectBinding.apply(null, arguments);
  },
  submittedIntentHash: function submittedIntentHash() {
    return require('./commands').submittedIntentHash.apply(null, arguments);
  },
  allowedUnits,
  assertJournalEntryEffectKey: function assertJournalEntryEffectKey() {
    return require('./lifecycle').assertJournalEntryEffectKey.apply(null, arguments);
  },
  buildAggregate,
  buildContext,
  convertToCanonical,
  finalize: function finalize() {
    return require('./lifecycle').finalize.apply(null, arguments);
  },
  finalizeBatch: function finalizeBatch() {
    return require('./lifecycle').finalizeBatch.apply(null, arguments);
  },
  loadCatalog,
  resolveOptions,
  saveDraft: function saveDraft() {
    return require('./lifecycle').saveDraft.apply(null, arguments);
  },
  validateEntry,
  validateSelections,
  void_: function void_() {
    return require('./lifecycle').void_.apply(null, arguments);
  },
  errorResponse: journalApi.errorResponse,
  exportJson: journalApi.exportJson,
  exportResearchPackage: journalApi.exportResearchPackage,
  exportWideCsv: journalApi.exportWideCsv,
  handleHttpRequest: journalApi.handleHttpRequest,
  listEntries: journalApi.listEntries,
  listPlotGroups: journalApi.listPlotGroups,
  listPlots: journalApi.listPlots,
  loadCurrentAggregate: journalApi.loadCurrentAggregate,
  loadScopedCatalog: journalApi.loadScopedCatalog,
  resolvePrincipal: journalApi.resolvePrincipal,
  safeFilename: journalApi.safeFilename,
  saveEntry: journalApi.saveEntry,
  upsertCustomVocab: journalApi.upsertCustomVocab,
  upsertPlot: journalApi.upsertPlot,
  upsertPlotGroup: journalApi.upsertPlotGroup,
  verifyBearer: journalApi.verifyBearer,
  voidEntry: journalApi.voidEntry,
};
