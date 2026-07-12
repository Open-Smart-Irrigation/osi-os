'use strict';

const { loadCatalog } = require('./catalog');

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

function predicateResult(predicate, selections) {
  if (!predicate || typeof predicate !== 'object' || Array.isArray(predicate) ||
      typeof predicate.field !== 'string' || !['eq', 'in'].includes(predicate.op)) {
    return { valid: false, matches: false };
  }
  const actualValues = selections.has(predicate.field) ? selections.get(predicate.field) : [];
  if (predicate.op === 'eq') {
    return {
      valid: true,
      matches: actualValues.some(function(actual) { return Object.is(actual, predicate.value); }),
    };
  }
  if (!Array.isArray(predicate.value)) return { valid: false, matches: false };
  return {
    valid: true,
    matches: actualValues.some(function(actual) { return predicate.value.includes(actual); }),
  };
}

function definitionFieldRules(definition) {
  const rules = [];
  const fieldLists = [definition.fields || []];
  for (const section of definition.sections || []) fieldLists.push((section && section.fields) || []);
  for (const fields of fieldLists) {
    for (const field of fields) {
      if (!field || typeof field !== 'object' || Array.isArray(field)) continue;
      const code = field.code || field.attribute_code || field.field;
      if (typeof code === 'string') rules.push(Object.assign({}, field, { code }));
    }
  }
  return rules;
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

function validateEntry(catalog, _layoutDef, _templateDef, entryInput) {
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
  if (!activity || activity.kind !== 'activity' || activity.active !== 1 || activity.deleted_at) {
    return errorResult('activity_code', 'unknown_code', 'Unknown or inactive activity code');
  }
  const compatibilityErrors = [];
  const layoutDefinition = _layoutDef && _layoutDef.definition;
  const templateDefinition = _templateDef && _templateDef.definition;
  if (!_layoutDef || !layoutDefinition || typeof layoutDefinition !== 'object' ||
      (_layoutDef.catalog_errors || []).includes('definition_json')) {
    compatibilityErrors.push({
      field: 'layout_code', code: 'invalid_catalog', message: 'Layout definition is invalid',
    });
  } else {
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
  } else if (_templateDef.code && _templateDef.code !== entryInput.template_code) {
    compatibilityErrors.push({
      field: 'template_code', code: 'definition_mismatch', message: 'Template does not match its definition',
    });
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
    if (!attribute || attribute.kind !== 'attribute' || attribute.active !== 1 || attribute.deleted_at) {
      return errorResult(
        'values[' + index + '].attribute_code',
        'unknown_code',
        'Unknown or inactive attribute code'
      );
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
    if (valueStatus !== 'observed' && value.value != null) {
      return errorResult(
        'values[' + index + '].value',
        'invalid_status_value',
        'A non-observed value must not carry a value'
      );
    }
    if (valueStatus === 'observed') {
      const type = attribute.value_type;
      const validType = (
        (type === 'number' && typeof value.value === 'number' && Number.isFinite(value.value)) ||
        (type === 'text' && typeof value.value === 'string') ||
        (type === 'choice' && typeof value.value === 'string') ||
        (type === 'date' && typeof value.value === 'string' && Number.isFinite(Date.parse(value.value))) ||
        (type === 'boolean' && typeof value.value === 'boolean')
      );
      if (!validType) {
        return errorResult(
          'values[' + index + '].value',
          'invalid_type',
          'Value does not match the attribute type'
        );
      }
    }
    if (valueStatus === 'observed' && attribute.value_type === 'text' &&
        Buffer.byteLength(value.value, 'utf8') > 4096) {
      return errorResult(
        'values[' + index + '].value',
        'limit_exceeded',
        'Text value exceeds the 4096 byte limit'
      );
    }
    if (valueStatus === 'observed' && attribute.value_type === 'choice') {
      const choice = catalog.vocabByCode.get(value.value);
      if (!choice || choice.kind !== 'choice' || choice.parent_code !== attribute.code ||
          choice.active !== 1 || choice.deleted_at) {
        return errorResult(
          'values[' + index + '].value',
          'invalid_choice',
          'Choice is not valid for this attribute'
        );
      }
    }
    if (valueStatus === 'observed' && attribute.value_type === 'number') {
      if (typeof attribute.constraints.min === 'number' && value.value < attribute.constraints.min) {
        return errorResult('values[' + index + '].value', 'below_minimum', 'Value is below the minimum');
      }
      if (typeof attribute.constraints.max === 'number' && value.value > attribute.constraints.max) {
        return errorResult('values[' + index + '].value', 'above_maximum', 'Value is above the maximum');
      }
      if (typeof attribute.constraints.step === 'number' && attribute.constraints.step > 0) {
        const base = typeof attribute.constraints.min === 'number' ? attribute.constraints.min : 0;
        const quotient = (value.value - base) / attribute.constraints.step;
        const tolerance = 1e-9 * Math.max(1, Math.abs(quotient));
        if (Math.abs(quotient - Math.round(quotient)) > tolerance) {
          return errorResult('values[' + index + '].value', 'step_mismatch', 'Value does not match the step');
        }
      }
    }
    if (valueStatus === 'observed' && typeof value.value === 'string' &&
        typeof attribute.constraints.maxlength === 'number' &&
        Array.from(value.value).length > attribute.constraints.maxlength) {
      return errorResult(
        'values[' + index + '].value',
        'limit_exceeded',
        'Value exceeds the catalog length limit'
      );
    }
    normalizedValues.push(Object.assign({}, value, {
      group_index: groupIndex,
      value_status: valueStatus,
    }));
  }
  const present = new Set(normalizedValues.map(function(value) { return value.attribute_code; }));
  for (const [field, value] of Object.entries(entryInput)) {
    if (value == null || (typeof value === 'string' && value.trim() === '')) continue;
    present.add(field);
  }
  const definition = templateDefinition;
  const activityRequirements = definition.activity_requirements;
  const requirements = activityRequirements && activityRequirements[entryInput.activity_code];
  const errors = requiredErrors(requirements, present);
  for (const group of definition.conditional_groups || []) {
    if (Array.isArray(group.activity_codes) && group.activity_codes.includes(entryInput.activity_code)) {
      errors.push(...requiredErrors(group, present));
    }
  }
  const selections = new Map();
  for (const [field, value] of Object.entries(entryInput)) selections.set(field, [value]);
  for (const value of normalizedValues) {
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

module.exports = { loadCatalog, validateEntry };
