'use strict';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function nonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function catalogError(field, message) {
  return { field, code: 'invalid_catalog', message };
}

function definitionObject(layoutDef) {
  if (isPlainObject(layoutDef) && isPlainObject(layoutDef.definition) &&
      !hasOwn(layoutDef, 'option_dependencies')) {
    return layoutDef.definition;
  }
  return layoutDef;
}

function sameMembers(left, right) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every(function(value) { return rightSet.has(value); });
}

function dependencyShape(layoutDef, path) {
  const definition = definitionObject(layoutDef);
  const basePath = path || 'option_dependencies';
  if (!isPlainObject(definition)) {
    return { ok: false, errors: [catalogError(basePath, 'Layout definition must be an object')] };
  }
  if (!hasOwn(definition, 'option_dependencies')) {
    return { ok: true, rules: [], targetKinds: new Map() };
  }
  if (!Array.isArray(definition.option_dependencies)) {
    return {
      ok: false,
      errors: [catalogError(basePath, 'option_dependencies must be an array')],
    };
  }

  const errors = [];
  const rules = [];
  const targetKinds = new Map();
  const duplicateRules = new Map();
  definition.option_dependencies.forEach(function(rule, index) {
    const rulePath = basePath + '[' + index + ']';
    if (!isPlainObject(rule)) {
      errors.push(catalogError(rulePath, 'Dependency rule must be an object'));
      return;
    }
    const when = rule.when;
    const restrict = rule.restrict;
    if (!isPlainObject(when) || !nonemptyString(when.attribute_code) ||
        !nonemptyString(when.equals) ||
        Object.keys(when).some(function(key) {
          return !['attribute_code', 'equals'].includes(key);
        })) {
      errors.push(catalogError(
        rulePath + '.when',
        'when must contain only nonempty attribute_code and equals strings'
      ));
      return;
    }
    if (!isPlainObject(restrict) || !nonemptyString(restrict.attribute_code)) {
      errors.push(catalogError(
        rulePath + '.restrict',
        'restrict must contain a nonempty attribute_code'
      ));
      return;
    }
    if (Object.keys(restrict).some(function(key) {
      return !['attribute_code', 'choices', 'units'].includes(key);
    })) {
      errors.push(catalogError(
        rulePath + '.restrict',
        'restrict contains an unsupported behavior key'
      ));
      return;
    }
    const hasChoices = hasOwn(restrict, 'choices');
    const hasUnits = hasOwn(restrict, 'units');
    if (hasChoices === hasUnits) {
      errors.push(catalogError(
        rulePath + '.restrict',
        'restrict must contain exactly one of choices or units'
      ));
      return;
    }
    const kind = hasChoices ? 'choices' : 'units';
    const restrictedValues = restrict[kind];
    if (!Array.isArray(restrictedValues) || restrictedValues.length === 0 ||
        restrictedValues.some(function(value) { return !nonemptyString(value); }) ||
        new Set(restrictedValues).size !== restrictedValues.length) {
      errors.push(catalogError(
        rulePath + '.restrict.' + kind,
        kind + ' must be a nonempty array of unique nonempty strings'
      ));
      return;
    }
    const previousKind = targetKinds.get(restrict.attribute_code);
    if (previousKind && previousKind !== kind) {
      errors.push(catalogError(
        rulePath + '.restrict.attribute_code',
        'One dependency target cannot mix choice and unit restrictions'
      ));
      return;
    }
    targetKinds.set(restrict.attribute_code, kind);

    const duplicateKey = [
      when.attribute_code, when.equals, restrict.attribute_code,
    ].join('\u0000');
    const previous = duplicateRules.get(duplicateKey);
    if (previous && (previous.kind !== kind ||
        !sameMembers(previous.values, restrictedValues))) {
      errors.push(catalogError(
        rulePath,
        'Conflicting duplicate dependency rules are not allowed'
      ));
      return;
    }
    if (!previous) {
      duplicateRules.set(duplicateKey, { kind, values: restrictedValues });
    }
    rules.push({ rule, index, when, restrict, kind, values: restrictedValues });
  });

  return errors.length
    ? { ok: false, errors }
    : { ok: true, rules, targetKinds };
}

function addSelected(map, attributeCode, value) {
  if (value == null) return;
  if (!map.has(attributeCode)) map.set(attributeCode, []);
  map.get(attributeCode).push(value);
}

function selectionMap(selections) {
  const selected = new Map();
  if (Array.isArray(selections)) {
    selections.forEach(function(row) {
      if (!isPlainObject(row) || !nonemptyString(row.attribute_code)) return;
      const value = row.value != null ? row.value : row.value_text;
      addSelected(selected, row.attribute_code, value);
    });
    return selected;
  }
  const entries = selections instanceof Map
    ? selections.entries()
    : isPlainObject(selections)
      ? Object.entries(selections)
      : [];
  for (const [attributeCode, rawValue] of entries) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    values.forEach(function(value) { addSelected(selected, attributeCode, value); });
  }
  return selected;
}

function addUnique(target, values) {
  let changed = false;
  for (const value of values) {
    if (target.includes(value)) continue;
    target.push(value);
    changed = true;
  }
  return changed;
}

function resolveCompiled(compiled, selections) {
  const selected = selectionMap(selections);
  const targetAttributes = new Set(compiled.targetKinds.keys());
  const resolved = {};
  for (const target of targetAttributes) {
    resolved[target] = { choices: [], units: [] };
  }

  const validSelections = new Map();
  for (const [attributeCode, values] of selected) {
    if (!targetAttributes.has(attributeCode)) {
      validSelections.set(attributeCode, new Set(values));
    }
  }

  let changed = true;
  let attempts = 0;
  while (changed && attempts <= compiled.rules.length + 1) {
    changed = false;
    attempts += 1;
    for (const dependency of compiled.rules) {
      const sourceValues = validSelections.get(dependency.when.attribute_code);
      if (!sourceValues || !sourceValues.has(dependency.when.equals)) continue;
      if (addUnique(
        resolved[dependency.restrict.attribute_code][dependency.kind],
        dependency.values
      )) changed = true;
    }
    for (const [target, kind] of compiled.targetKinds) {
      if (kind !== 'choices' || !selected.has(target)) continue;
      const allowed = new Set(resolved[target].choices);
      if (!validSelections.has(target)) validSelections.set(target, new Set());
      const valid = validSelections.get(target);
      for (const value of selected.get(target)) {
        if (allowed.has(value) && !valid.has(value)) {
          valid.add(value);
          changed = true;
        }
      }
    }
  }
  return resolved;
}

function resolveOptions(layoutDef, selections) {
  const compiled = dependencyShape(layoutDef);
  if (!compiled.ok) return { ok: false, errors: compiled.errors };
  return resolveCompiled(compiled, selections);
}

function validateSelections(layoutDef, values) {
  const compiled = dependencyShape(layoutDef);
  if (!compiled.ok) return { ok: false, errors: compiled.errors };
  if (!Array.isArray(values)) {
    return {
      ok: false,
      errors: [{ field: 'values', code: 'invalid_selection' }],
    };
  }
  const resolved = resolveCompiled(compiled, values);
  const errors = [];
  values.forEach(function(row, index) {
    if (!isPlainObject(row)) return;
    const kind = compiled.targetKinds.get(row.attribute_code);
    if (!kind) return;
    if (kind === 'choices') {
      const value = row.value != null ? row.value : row.value_text;
      if (value == null) return;
      if (!resolved[row.attribute_code].choices.includes(value)) {
        errors.push({
          field: 'values[' + index + '].value',
          code: 'invalid_under_dependency',
        });
      }
      return;
    }
    const enteredUnit = row.entered_unit_code != null
      ? row.entered_unit_code
      : row.unit_code;
    if (enteredUnit == null) return;
    if (!resolved[row.attribute_code].units.includes(enteredUnit)) {
      errors.push({
        field: 'values[' + index + '].' +
          (row.entered_unit_code != null ? 'entered_unit_code' : 'unit_code'),
        code: 'invalid_under_dependency',
      });
    }
  });
  return errors.length ? { ok: false, errors } : { ok: true };
}

function dependencyCatalogErrors(catalog, layoutDef, path) {
  const basePath = path || 'layout_definition.option_dependencies';
  const compiled = dependencyShape(layoutDef, basePath);
  if (!compiled.ok) return compiled.errors;
  const terms = catalog && catalog.vocabByCode instanceof Map
    ? catalog.vocabByCode
    : null;
  if (!terms) {
    return [catalogError(basePath, 'Vocabulary catalog is unavailable')];
  }
  const errors = [];
  for (const dependency of compiled.rules) {
    const rulePath = basePath + '[' + dependency.index + ']';
    const sourceCode = dependency.when.attribute_code;
    if (sourceCode === 'activity_code') {
      const activity = terms.get(dependency.when.equals);
      if (!activity || activity.kind !== 'activity') {
        errors.push(catalogError(
          rulePath + '.when.equals',
          'Dependency references an unknown activity'
        ));
      }
    } else {
      const source = terms.get(sourceCode);
      if (!source || source.kind !== 'attribute' || source.value_type !== 'choice') {
        errors.push(catalogError(
          rulePath + '.when.attribute_code',
          'Dependency source must be a known choice attribute'
        ));
      } else {
        const sourceChoice = terms.get(dependency.when.equals);
        if (!sourceChoice || sourceChoice.kind !== 'choice' ||
            sourceChoice.parent_code !== sourceCode) {
          errors.push(catalogError(
            rulePath + '.when.equals',
            'Dependency source value is not a choice for its attribute'
          ));
        }
      }
    }

    const targetCode = dependency.restrict.attribute_code;
    const target = terms.get(targetCode);
    if (!target || target.kind !== 'attribute') {
      errors.push(catalogError(
        rulePath + '.restrict.attribute_code',
        'Dependency target must be a known attribute'
      ));
      continue;
    }
    if (dependency.kind === 'choices') {
      if (target.value_type !== 'choice') {
        errors.push(catalogError(
          rulePath + '.restrict.choices',
          'Choice restrictions require a choice attribute target'
        ));
        continue;
      }
      dependency.values.forEach(function(code, choiceIndex) {
        const choice = terms.get(code);
        if (!choice || choice.kind !== 'choice' || choice.parent_code !== targetCode) {
          errors.push(catalogError(
            rulePath + '.restrict.choices[' + choiceIndex + ']',
            'Restricted choice is not a choice for the target attribute'
          ));
        }
      });
    } else {
      if (target.value_type !== 'number') {
        errors.push(catalogError(
          rulePath + '.restrict.units',
          'Unit restrictions require a numeric attribute target'
        ));
        continue;
      }
      dependency.values.forEach(function(code, unitIndex) {
        const unit = terms.get(code);
        if (!unit || unit.kind !== 'unit') {
          errors.push(catalogError(
            rulePath + '.restrict.units[' + unitIndex + ']',
            'Dependency references an unknown unit'
          ));
        }
      });
    }
  }
  return errors;
}

module.exports = {
  dependencyCatalogErrors,
  resolveOptions,
  validateSelections,
};
