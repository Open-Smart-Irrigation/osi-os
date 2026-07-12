'use strict';

// Cascade-free Task-4 quantity semantics shared by conversion, unit pickers,
// and catalog-aware dependency preflight.

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

module.exports = {
  numericAttributePreflight,
  resolveConversion,
};
