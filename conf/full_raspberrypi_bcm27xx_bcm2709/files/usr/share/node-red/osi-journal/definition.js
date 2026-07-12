'use strict';

// Template/layout field references may target only persisted entry properties
// or catalog attributes. Keeping this list explicit makes misspellings fail closed.
const TOP_LEVEL_ENTRY_FIELDS = new Set([
  'entry_uuid', 'owner_user_uuid', 'user_id', 'author_principal_uuid', 'author_label',
  'plot_uuid', 'zone_id', 'zone_uuid', 'device_eui', 'season_uuid', 'season_crop',
  'season_variety', 'campaign_uuid', 'protocol_code', 'protocol_version',
  'observation_unit_code', 'pass_uuid', 'batch_uuid', 'activity_code', 'template_code',
  'template_version', 'layout_code', 'layout_version', 'catalog_version', 'occurred_start',
  'occurred_start_local', 'occurred_end', 'occurred_end_local', 'occurred_timezone',
  'occurred_utc_offset_minutes', 'recorded_at', 'origin', 'status', 'note', 'context',
  'context_json', 'voided_at', 'voided_by_principal_uuid', 'void_reason', 'sync_version',
  'base_sync_version', 'gateway_device_eui', 'created_at', 'updated_at', 'deleted_at', 'values',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function predicateResult(predicate, selections) {
  if (!isPlainObject(predicate) || typeof predicate.field !== 'string' ||
      !['eq', 'in'].includes(predicate.op)) {
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
  for (const section of definition.sections || []) fieldLists.push(section.fields || []);
  for (const fields of fieldLists) {
    for (const field of fields) {
      if (!isPlainObject(field)) continue;
      const code = field.code || field.attribute_code || field.field;
      if (typeof code === 'string') rules.push(Object.assign({}, field, { code }));
    }
  }
  return rules;
}

function knownDefinitionField(catalog, code) {
  if (TOP_LEVEL_ENTRY_FIELDS.has(code)) return true;
  const term = catalog.vocabByCode.get(code);
  return Boolean(term) && term.kind === 'attribute';
}

function catalogShapeError(errors, path, message) {
  errors.push({ field: path, code: 'invalid_catalog', message });
}

function validateFieldReference(catalog, code, path, errors) {
  if (typeof code !== 'string' || !knownDefinitionField(catalog, code)) {
    catalogShapeError(errors, path, 'Definition references an unknown field');
    return false;
  }
  return true;
}

function validatePredicateDefinition(catalog, predicate, path, errors) {
  if (!isPlainObject(predicate) || typeof predicate.field !== 'string' ||
      !['eq', 'in'].includes(predicate.op) ||
      !Object.prototype.hasOwnProperty.call(predicate, 'value')) {
    catalogShapeError(errors, path, 'Predicate must contain field, eq/in op, and value');
    return;
  }
  validateFieldReference(catalog, predicate.field, path + '.field', errors);
  if (predicate.op === 'in' && !Array.isArray(predicate.value)) {
    catalogShapeError(errors, path + '.value', 'An in predicate value must be an array');
  }
}

function validateDefinitionFields(catalog, fields, path, errors) {
  if (!Array.isArray(fields)) {
    catalogShapeError(errors, path, 'Definition fields must be an array');
    return;
  }
  fields.forEach(function(field, index) {
    const fieldPath = path + '[' + index + ']';
    if (typeof field === 'string') {
      validateFieldReference(catalog, field, fieldPath, errors);
      return;
    }
    if (!isPlainObject(field)) {
      catalogShapeError(errors, fieldPath, 'A field must be a code or field-rule object');
      return;
    }
    const code = field.code || field.attribute_code || field.field;
    validateFieldReference(catalog, code, fieldPath + '.code', errors);
    if (field.required != null && typeof field.required !== 'boolean') {
      catalogShapeError(errors, fieldPath + '.required', 'required must be boolean');
    }
    if (field.required_if != null) {
      validatePredicateDefinition(catalog, field.required_if, fieldPath + '.required_if', errors);
    }
    if (field.visible_if != null) {
      validatePredicateDefinition(catalog, field.visible_if, fieldPath + '.visible_if', errors);
    }
  });
}

function validateDefinitionFieldList(catalog, value, path, errors) {
  if (!Array.isArray(value)) {
    catalogShapeError(errors, path, 'Field list must be an array');
    return;
  }
  value.forEach(function(code, index) {
    validateFieldReference(catalog, code, path + '[' + index + ']', errors);
  });
}

function validateRequirementDefinition(catalog, requirement, path, errors) {
  if (!isPlainObject(requirement)) {
    catalogShapeError(errors, path, 'Requirement must be an object');
    return;
  }
  if (requirement.required != null) {
    validateDefinitionFieldList(catalog, requirement.required, path + '.required', errors);
  }
  if (requirement.optional != null) {
    validateDefinitionFieldList(catalog, requirement.optional, path + '.optional', errors);
  }
  if (requirement.required_any != null) {
    if (!Array.isArray(requirement.required_any)) {
      catalogShapeError(errors, path + '.required_any', 'required_any must be an array of field arrays');
    } else {
      requirement.required_any.forEach(function(family, index) {
        const familyPath = path + '.required_any[' + index + ']';
        if (!Array.isArray(family) || family.length === 0) {
          catalogShapeError(errors, familyPath, 'Each required_any family must be a nonempty array');
        } else {
          validateDefinitionFieldList(catalog, family, familyPath, errors);
        }
      });
    }
  }
}

function validateActivityList(catalog, value, path, errors) {
  if (!Array.isArray(value)) {
    catalogShapeError(errors, path, 'Activity codes must be an array');
    return;
  }
  value.forEach(function(code, index) {
    const term = typeof code === 'string' && catalog.vocabByCode.get(code);
    if (!term || term.kind !== 'activity') {
      catalogShapeError(errors, path + '[' + index + ']', 'Definition references an unknown activity');
    }
  });
}

function semanticDefinitionErrors(catalog, definition, path) {
  const errors = [];
  if (!(catalog && catalog.vocabByCode instanceof Map) || !isPlainObject(definition)) {
    catalogShapeError(errors, path, 'Definition and vocabulary catalog must be objects');
    return errors;
  }
  if (definition.fields != null) {
    validateDefinitionFields(catalog, definition.fields, path + '.fields', errors);
  }
  if (definition.sections != null) {
    if (!Array.isArray(definition.sections)) {
      catalogShapeError(errors, path + '.sections', 'Sections must be an array');
    } else {
      definition.sections.forEach(function(section, index) {
        const sectionPath = path + '.sections[' + index + ']';
        if (!isPlainObject(section)) {
          catalogShapeError(errors, sectionPath, 'Section must be an object');
        } else if (section.fields != null) {
          validateDefinitionFields(catalog, section.fields, sectionPath + '.fields', errors);
        }
      });
    }
  }
  for (const key of ['minimum_fields', 'carry_forward']) {
    if (definition[key] != null) {
      validateDefinitionFieldList(catalog, definition[key], path + '.' + key, errors);
    }
  }
  if (definition.conditional_fields != null) {
    if (!isPlainObject(definition.conditional_fields)) {
      catalogShapeError(errors, path + '.conditional_fields', 'conditional_fields must be an object');
    } else {
      for (const [key, fields] of Object.entries(definition.conditional_fields)) {
        validateDefinitionFieldList(catalog, fields, path + '.conditional_fields.' + key, errors);
      }
    }
  }
  if (definition.activity_codes != null) {
    validateActivityList(catalog, definition.activity_codes, path + '.activity_codes', errors);
  }
  if (definition.supported_templates != null) {
    if (!Array.isArray(definition.supported_templates)) {
      catalogShapeError(errors, path + '.supported_templates', 'supported_templates must be an array');
    } else {
      definition.supported_templates.forEach(function(code, index) {
        if (typeof code !== 'string' || !(catalog.templates instanceof Map) ||
            !catalog.templates.has(code)) {
          catalogShapeError(
            errors,
            path + '.supported_templates[' + index + ']',
            'Definition references an unknown template'
          );
        }
      });
    }
  }
  if (definition.activity_requirements != null) {
    if (!isPlainObject(definition.activity_requirements)) {
      catalogShapeError(errors, path + '.activity_requirements', 'activity_requirements must be an object');
    } else {
      for (const [activityCode, requirement] of Object.entries(definition.activity_requirements)) {
        validateActivityList(catalog, [activityCode], path + '.activity_requirements', errors);
        validateRequirementDefinition(
          catalog,
          requirement,
          path + '.activity_requirements.' + activityCode,
          errors
        );
      }
    }
  }
  if (definition.requirements != null) {
    validateRequirementDefinition(catalog, definition.requirements, path + '.requirements', errors);
  }
  if (definition.required != null || definition.required_any != null) {
    validateRequirementDefinition(catalog, definition, path, errors);
  }
  if (definition.conditional_groups != null) {
    if (!Array.isArray(definition.conditional_groups)) {
      catalogShapeError(errors, path + '.conditional_groups', 'conditional_groups must be an array');
    } else {
      definition.conditional_groups.forEach(function(group, index) {
        const groupPath = path + '.conditional_groups[' + index + ']';
        if (!isPlainObject(group)) {
          catalogShapeError(errors, groupPath, 'Conditional group must be an object');
          return;
        }
        validateActivityList(catalog, group.activity_codes, groupPath + '.activity_codes', errors);
        validateRequirementDefinition(catalog, group, groupPath, errors);
      });
    }
  }
  return errors;
}

module.exports = {
  TOP_LEVEL_ENTRY_FIELDS,
  definitionFieldRules,
  predicateResult,
  semanticDefinitionErrors,
};
