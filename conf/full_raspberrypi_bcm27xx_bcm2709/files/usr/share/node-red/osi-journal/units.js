'use strict';

const { dependencyCatalogErrors, resolveOptions } = require('./cascade');
const {
  numericAttributePreflight,
  resolveConversion,
} = require('./unit-family');

// Public conversion failures are stable machine codes:
// invalid_catalog, inactive_attribute, unknown_unit, inactive_unit,
// unit_incompatible, cross_basis_forbidden, unit_required, invalid_number,
// and invalid_value_shape.

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
