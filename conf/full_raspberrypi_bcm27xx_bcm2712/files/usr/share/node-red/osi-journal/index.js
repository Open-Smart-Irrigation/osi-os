'use strict';

const { loadCatalog } = require('./catalog');
const {
  definitionFieldRules,
  predicateResult,
  semanticDefinitionErrors,
} = require('./definition');

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

function logicalValueRow(row) {
  const valueStatus = row && row.value_status != null ? row.value_status : 'observed';
  let value = null;
  if (valueStatus === 'observed' && row) {
    if (Object.prototype.hasOwnProperty.call(row, 'value')) value = row.value;
    else if (row.value_num != null) value = row.value_num;
    else if (row.value_text != null) value = row.value_text;
  }
  return {
    attribute_code: row && row.attribute_code,
    group_index: row && row.group_index != null ? row.group_index : 0,
    value,
    value_status: valueStatus,
    unit_code: row && row.unit_code != null ? row.unit_code : null,
  };
}

function sameLogicalValue(left, right) {
  const a = logicalValueRow(left);
  const b = logicalValueRow(right);
  return a.attribute_code === b.attribute_code &&
    a.group_index === b.group_index &&
    Object.is(a.value, b.value) &&
    a.value_status === b.value_status &&
    a.unit_code === b.unit_code;
}

function preservedOriginalValue(originalEntry, value) {
  return originalEntry.values.some(function(originalValue) {
    return sameLogicalValue(originalValue, value);
  });
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

function isCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

function referenceError(catalog, constraints, value, validationContext) {
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
    return product && product.active === 1 && !product.deleted_at
      ? null
      : { code: 'invalid_reference', message: 'Product reference is unknown or inactive' };
  }
  const referenceValues = validationContext.referenceValues;
  let allowed;
  if (referenceValues instanceof Map) allowed = referenceValues.get(key);
  else if (isPlainObject(referenceValues) &&
           Object.prototype.hasOwnProperty.call(referenceValues, key)) allowed = referenceValues[key];
  else if (referenceValues != null && !isPlainObject(referenceValues)) {
    return { code: 'invalid_context', message: 'referenceValues must be a Map or object' };
  }
  if (allowed == null) {
    return { code: 'reference_unresolved', message: 'No resolver was supplied for this reference' };
  }
  if (!(allowed instanceof Set) && !Array.isArray(allowed)) {
    return { code: 'invalid_context', message: 'Reference resolver values must be a Set or array' };
  }
  const found = allowed instanceof Set ? allowed.has(value) : allowed.includes(value);
  return found ? null : { code: 'invalid_reference', message: 'Reference value does not exist' };
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
      return errorResult(
        'values[' + index + '].attribute_code',
        'unknown_code',
        'Unknown attribute code'
      );
    }
    const valuePreserved = correction && preservedOriginalValue(originalEntry, Object.assign({}, value, {
      group_index: groupIndex,
      value_status: valueStatus,
    }));
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
        (type === 'date' && typeof value.value === 'string') ||
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
    if (valueStatus === 'observed' && attribute.value_type === 'date' &&
        !isCalendarDate(value.value)) {
      return errorResult(
        'values[' + index + '].value',
        'invalid_date',
        'Date value must be a real YYYY-MM-DD calendar date'
      );
    }
    if (valueStatus === 'observed') {
      const invalidReference = referenceError(catalog, attribute.constraints, value.value, context);
      if (invalidReference) {
        return errorResult(
          'values[' + index + '].value',
          invalidReference.code,
          invalidReference.message
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
      if (!choice || choice.kind !== 'choice' || choice.parent_code !== attribute.code) {
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

module.exports = { loadCatalog, validateEntry };
