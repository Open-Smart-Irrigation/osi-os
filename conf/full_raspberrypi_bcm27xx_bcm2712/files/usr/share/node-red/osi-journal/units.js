'use strict';

const { dependencyCatalogErrors, resolveOptions } = require('./cascade');

// Public conversion failures are stable machine codes:
// invalid_catalog, inactive_attribute, unknown_unit, inactive_unit,
// unit_incompatible, cross_basis_forbidden, unit_required, invalid_number,
// and invalid_value_shape.

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isActive(row) {
  return Boolean(row) && row.active === 1 && !row.deleted_at;
}

function catalogTerms(catalog) {
  return catalog && catalog.vocabByCode instanceof Map ? catalog.vocabByCode : null;
}

function numericConstraintsValid(attribute) {
  const constraints = attribute.constraints;
  if (!isPlainObject(constraints) ||
      (attribute.catalog_errors || []).includes('constraints_json')) {
    return false;
  }
  for (const key of ['min', 'max']) {
    if (hasOwn(constraints, key) &&
        (typeof constraints[key] !== 'number' || !Number.isFinite(constraints[key]))) {
      return false;
    }
  }
  if (hasOwn(constraints, 'min') && hasOwn(constraints, 'max') &&
      constraints.min > constraints.max) {
    return false;
  }
  if (hasOwn(constraints, 'step') &&
      (typeof constraints.step !== 'number' || !Number.isFinite(constraints.step) ||
       constraints.step <= 0)) {
    return false;
  }
  for (const key of ['requires_explicit_unit', 'allow_default_unit']) {
    if (hasOwn(constraints, key) && typeof constraints[key] !== 'boolean') return false;
  }
  if (hasOwn(constraints, 'semantic_discriminator') &&
      constraints.semantic_discriminator !== 'unit_code') {
    return false;
  }

  if (attribute.default_unit_code == null) {
    return constraints.requires_explicit_unit === true &&
      constraints.allow_default_unit === false &&
      constraints.semantic_discriminator === 'unit_code';
  }
  return typeof attribute.default_unit_code === 'string' && Boolean(attribute.default_unit_code);
}

function unitFacts(row) {
  if (!row || row.kind !== 'unit' || typeof row.quantity_kind !== 'string' ||
      !row.quantity_kind || typeof row.basis !== 'string' || !row.basis ||
      !isPlainObject(row.constraints) ||
      (row.catalog_errors || []).includes('constraints_json')) {
    return null;
  }
  const conversion = row.constraints.to_canonical;
  if (typeof row.constraints.dimension !== 'string' || !row.constraints.dimension ||
      !isPlainObject(conversion) || typeof conversion.unit_code !== 'string' ||
      !conversion.unit_code || typeof conversion.scale !== 'number' ||
      !Number.isFinite(conversion.scale) || conversion.scale <= 0 ||
      typeof conversion.offset !== 'number' || !Number.isFinite(conversion.offset)) {
    return null;
  }
  return {
    quantity_kind: row.quantity_kind,
    basis: row.basis,
    dimension: row.constraints.dimension,
    canonical_unit_code: conversion.unit_code,
    scale: conversion.scale,
    offset: conversion.offset,
  };
}

function canonicalRowError(terms, facts, options) {
  const target = terms.get(facts.canonical_unit_code);
  if (!target || target.kind !== 'unit') return { code: 'invalid_catalog' };
  const targetFacts = unitFacts(target);
  if (!targetFacts || targetFacts.quantity_kind !== facts.quantity_kind ||
      targetFacts.basis !== facts.basis || targetFacts.dimension !== facts.dimension ||
      targetFacts.canonical_unit_code !== target.code || targetFacts.scale !== 1 ||
      targetFacts.offset !== 0) {
    return { code: 'invalid_catalog' };
  }
  if (!options.allowInactive && !isActive(target)) return { code: 'inactive_unit' };
  return { target, targetFacts };
}

function numericAttributePreflight(catalog, attributeCode, options) {
  const settings = Object.assign({ allowInactive: false }, options || {});
  const terms = catalogTerms(catalog);
  if (!terms) return { ok: false, code: 'invalid_catalog' };
  const attribute = terms.get(attributeCode);
  if (!attribute || attribute.kind !== 'attribute' || attribute.value_type !== 'number' ||
      typeof attribute.quantity_kind !== 'string' || !attribute.quantity_kind ||
      typeof attribute.basis !== 'string' || !attribute.basis ||
      !numericConstraintsValid(attribute)) {
    return { ok: false, code: 'invalid_catalog' };
  }
  if (!settings.allowInactive && !isActive(attribute)) {
    return { ok: false, code: 'inactive_attribute' };
  }

  let dimension = null;
  if (attribute.default_unit_code != null) {
    const defaultUnit = terms.get(attribute.default_unit_code);
    if (!defaultUnit || defaultUnit.kind !== 'unit') {
      return { ok: false, code: 'invalid_catalog' };
    }
    const defaultFacts = unitFacts(defaultUnit);
    if (!defaultFacts || defaultFacts.quantity_kind !== attribute.quantity_kind ||
        defaultFacts.basis !== attribute.basis) {
      return { ok: false, code: 'invalid_catalog' };
    }
    const canonical = canonicalRowError(terms, defaultFacts, settings);
    if (canonical.code) return { ok: false, code: canonical.code };
    if (canonical.target.code !== attribute.default_unit_code) {
      return { ok: false, code: 'invalid_catalog' };
    }
    if (!settings.allowInactive && !isActive(defaultUnit)) {
      return { ok: false, code: 'inactive_unit' };
    }
    dimension = defaultFacts.dimension;
  }

  return { ok: true, terms, attribute, dimension, allowInactive: settings.allowInactive };
}

function resolveConversion(attributeInfo, unitCode) {
  const row = attributeInfo.terms.get(unitCode);
  if (!row || row.kind !== 'unit') return { error: 'unknown_unit' };
  const facts = unitFacts(row);
  if (!facts) return { error: 'invalid_catalog' };
  if (!attributeInfo.allowInactive && !isActive(row)) return { error: 'inactive_unit' };

  // Catalog facts must be structurally valid before semantic classification.
  // Once valid, basis errors precede the broader quantity-family mismatch.
  if (facts.basis !== attributeInfo.attribute.basis) {
    return { error: 'cross_basis_forbidden' };
  }
  if (facts.quantity_kind !== attributeInfo.attribute.quantity_kind) {
    return { error: 'unit_incompatible' };
  }
  if (attributeInfo.dimension != null && facts.dimension !== attributeInfo.dimension) {
    return { error: 'unit_incompatible' };
  }

  const canonical = canonicalRowError(attributeInfo.terms, facts, attributeInfo);
  if (canonical.code) return { error: canonical.code };
  if (canonical.targetFacts.quantity_kind !== attributeInfo.attribute.quantity_kind ||
      canonical.targetFacts.basis !== attributeInfo.attribute.basis) {
    return { error: 'invalid_catalog' };
  }
  if (attributeInfo.attribute.default_unit_code != null &&
      canonical.target.code !== attributeInfo.attribute.default_unit_code) {
    return { error: 'invalid_catalog' };
  }
  return { row, facts, target: canonical.target };
}

function convertToCanonical(catalog, attributeCode, enteredValueNum, enteredUnitCode) {
  if (typeof enteredValueNum !== 'number' || !Number.isFinite(enteredValueNum)) {
    return { ok: false, code: 'invalid_number' };
  }
  const attributeInfo = numericAttributePreflight(catalog, attributeCode);
  if (!attributeInfo.ok) return attributeInfo;
  if (typeof enteredUnitCode !== 'string' || !enteredUnitCode) {
    return { ok: false, code: 'unknown_unit' };
  }
  const conversion = resolveConversion(attributeInfo, enteredUnitCode);
  if (conversion.error) return { ok: false, code: conversion.error };
  let valueNum = enteredValueNum * conversion.facts.scale + conversion.facts.offset;
  if (!Number.isFinite(valueNum)) return { ok: false, code: 'invalid_number' };
  if (valueNum === 0) valueNum = 0;
  return { ok: true, value_num: valueNum, unit_code: conversion.target.code };
}

function allowedUnits(catalog, attributeCode, layoutDef, selections) {
  const attributeInfo = numericAttributePreflight(catalog, attributeCode);
  if (!attributeInfo.ok) return [];
  const allowed = [];
  for (const [code, row] of attributeInfo.terms) {
    if (row.kind !== 'unit' || row.quantity_kind !== attributeInfo.attribute.quantity_kind ||
        row.basis !== attributeInfo.attribute.basis) {
      continue;
    }
    const conversion = resolveConversion(attributeInfo, code);
    if (!conversion.error) allowed.push(code);
  }
  allowed.sort();
  if (dependencyCatalogErrors(catalog, layoutDef).length) return [];
  const resolved = resolveOptions(layoutDef, selections);
  if (resolved && resolved.ok === false) return [];
  if (!Object.prototype.hasOwnProperty.call(resolved, attributeCode)) return allowed;
  const dependencyUnits = new Set(resolved[attributeCode].units);
  return allowed.filter(function(code) { return dependencyUnits.has(code); });
}

function missingRowRequiresUnit(attribute) {
  return attribute.default_unit_code == null ||
    attribute.constraints.requires_explicit_unit === true ||
    attribute.constraints.allow_default_unit === false ||
    attribute.constraints.semantic_discriminator === 'unit_code';
}

function normalizeMissingUnits(catalog, attributeCode, unitCode, enteredUnitCode) {
  const attributeInfo = numericAttributePreflight(catalog, attributeCode);
  if (!attributeInfo.ok) return attributeInfo;
  const hasCanonical = unitCode != null;
  const hasEntered = enteredUnitCode != null;
  if (!hasCanonical && !hasEntered) {
    return missingRowRequiresUnit(attributeInfo.attribute)
      ? { ok: false, code: 'unit_required' }
      : { ok: true };
  }

  let canonical;
  if (hasCanonical) {
    canonical = resolveConversion(attributeInfo, unitCode);
    if (canonical.error) return { ok: false, code: canonical.error };
    if (canonical.target.code !== unitCode) return { ok: false, code: 'invalid_value_shape' };
  }
  let entered;
  if (hasEntered) {
    entered = resolveConversion(attributeInfo, enteredUnitCode);
    if (entered.error) return { ok: false, code: entered.error };
  }
  if (canonical && entered && entered.target.code !== canonical.target.code) {
    return { ok: false, code: 'invalid_value_shape' };
  }
  return {
    ok: true,
    unit_code: canonical ? canonical.target.code : entered.target.code,
    entered_unit_code: entered ? enteredUnitCode : undefined,
  };
}

function validateFrozenUnitMetadata(catalog, attributeCode, row) {
  const attributeInfo = numericAttributePreflight(
    catalog,
    attributeCode,
    { allowInactive: true }
  );
  if (!attributeInfo.ok) return attributeInfo;
  const hasCanonical = row.unit_code != null;
  const hasEntered = row.entered_unit_code != null;
  if (!hasCanonical && !hasEntered) {
    return missingRowRequiresUnit(attributeInfo.attribute)
      ? { ok: false, code: 'unit_required' }
      : { ok: true };
  }
  const canonical = hasCanonical
    ? resolveConversion(attributeInfo, row.unit_code)
    : null;
  if (canonical && canonical.error) return { ok: false, code: canonical.error };
  const entered = hasEntered
    ? resolveConversion(attributeInfo, row.entered_unit_code)
    : null;
  if (entered && entered.error) return { ok: false, code: entered.error };
  if (canonical && canonical.target.code !== row.unit_code) {
    return { ok: false, code: 'invalid_value_shape' };
  }
  if (canonical && entered && entered.target.code !== row.unit_code) {
    return { ok: false, code: 'invalid_value_shape' };
  }
  return { ok: true };
}

function numericStepMatches(value, base, step) {
  const quotient = (value - base) / step;
  if (!Number.isFinite(quotient)) return false;
  const nearest = Math.round(quotient);
  const magnitude = Math.abs(quotient);
  const exponent = magnitude === 0 ? -1074 : Math.floor(Math.log2(magnitude));
  const ulp = exponent < -1022 ? Number.MIN_VALUE : 2 ** (exponent - 52);
  return Math.abs(quotient - nearest) <= 4 * ulp;
}

module.exports = {
  allowedUnits,
  convertToCanonical,
  normalizeMissingUnits,
  numericAttributePreflight,
  numericStepMatches,
  validateFrozenUnitMetadata,
};
