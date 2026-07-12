'use strict';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isActive(row) {
  return Boolean(row) && row.active === 1 && !row.deleted_at;
}

function catalogTerms(catalog) {
  return catalog && catalog.vocabByCode instanceof Map ? catalog.vocabByCode : null;
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
      !Number.isFinite(conversion.scale) || typeof conversion.offset !== 'number' ||
      !Number.isFinite(conversion.offset)) {
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

function canonicalRowError(terms, row, facts) {
  const target = terms.get(facts.canonical_unit_code);
  if (!target || target.kind !== 'unit') return { code: 'invalid_catalog' };
  if (!isActive(target)) return { code: 'inactive_unit' };
  const targetFacts = unitFacts(target);
  if (!targetFacts || targetFacts.quantity_kind !== facts.quantity_kind ||
      targetFacts.basis !== facts.basis || targetFacts.dimension !== facts.dimension ||
      targetFacts.canonical_unit_code !== target.code || targetFacts.scale !== 1 ||
      targetFacts.offset !== 0) {
    return { code: 'invalid_catalog' };
  }
  return { target, targetFacts };
}

function attributeFacts(catalog, attributeCode) {
  const terms = catalogTerms(catalog);
  if (!terms) return { error: 'invalid_catalog' };
  const attribute = terms.get(attributeCode);
  if (!attribute || attribute.kind !== 'attribute' || attribute.value_type !== 'number' ||
      typeof attribute.quantity_kind !== 'string' || !attribute.quantity_kind ||
      typeof attribute.basis !== 'string' || !attribute.basis ||
      !isPlainObject(attribute.constraints) ||
      (attribute.catalog_errors || []).includes('constraints_json')) {
    return { error: 'invalid_catalog' };
  }

  let dimension = null;
  if (attribute.default_unit_code != null) {
    if (typeof attribute.default_unit_code !== 'string' || !attribute.default_unit_code) {
      return { error: 'invalid_catalog' };
    }
    const defaultUnit = terms.get(attribute.default_unit_code);
    if (!defaultUnit || defaultUnit.kind !== 'unit') return { error: 'invalid_catalog' };
    if (!isActive(defaultUnit)) return { error: 'inactive_unit' };
    const defaultFacts = unitFacts(defaultUnit);
    if (!defaultFacts || defaultFacts.quantity_kind !== attribute.quantity_kind ||
        defaultFacts.basis !== attribute.basis) {
      return { error: 'invalid_catalog' };
    }
    const canonical = canonicalRowError(terms, defaultUnit, defaultFacts);
    if (canonical.code) return { error: canonical.code };
    dimension = defaultFacts.dimension;
  }

  return { terms, attribute, dimension };
}

function resolveConversion(attributeInfo, unitCode) {
  const row = attributeInfo.terms.get(unitCode);
  if (!row || row.kind !== 'unit') return { error: 'unknown_unit' };
  if (!isActive(row)) return { error: 'inactive_unit' };
  if (typeof row.quantity_kind !== 'string' || typeof row.basis !== 'string') {
    return { error: 'invalid_catalog' };
  }

  // Basis conversion needs denominator/formulation facts which Slice 1 does not
  // accept here. Report it before the broader family mismatch.
  if (row.basis !== attributeInfo.attribute.basis) {
    return { error: 'cross_basis_forbidden' };
  }
  if (row.quantity_kind !== attributeInfo.attribute.quantity_kind) {
    return { error: 'unit_incompatible' };
  }

  const facts = unitFacts(row);
  if (!facts) return { error: 'invalid_catalog' };
  if (attributeInfo.dimension != null && facts.dimension !== attributeInfo.dimension) {
    return { error: 'unit_incompatible' };
  }
  const canonical = canonicalRowError(attributeInfo.terms, row, facts);
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
  const attributeInfo = attributeFacts(catalog, attributeCode);
  if (attributeInfo.error) return { ok: false, code: attributeInfo.error };
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

function allowedUnits(catalog, attributeCode, _layoutDef, _selections) {
  const attributeInfo = attributeFacts(catalog, attributeCode);
  if (attributeInfo.error) return [];
  const allowed = [];
  for (const [code, row] of attributeInfo.terms) {
    if (!isActive(row) || row.kind !== 'unit' ||
        row.quantity_kind !== attributeInfo.attribute.quantity_kind ||
        row.basis !== attributeInfo.attribute.basis) {
      continue;
    }
    const conversion = resolveConversion(attributeInfo, code);
    if (!conversion.error) allowed.push(code);
  }
  return allowed.sort();
}

module.exports = { allowedUnits, convertToCanonical };
