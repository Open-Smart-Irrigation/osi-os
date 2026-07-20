#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const core = require('./journal-catalog-core');

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_PATH = path.join(
  REPO_ROOT,
  'docs/superpowers/specs/agroscope-open-field/catalog.json'
);
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'database/migrations/ordered');
const MANIFEST_PATH = path.join(MIGRATIONS_DIR, 'CHECKSUMS.json');
const SEED_PATH = path.join(REPO_ROOT, 'database/seed-blank.sql');
const SEED_BEGIN = '-- BEGIN GENERATED JOURNAL CATALOG V1';
const SEED_END = '-- END GENERATED JOURNAL CATALOG V1';
const FIXED_TIMESTAMP = '2026-07-12T00:00:00.000Z';

// Registry of catalog migrations, one entry per published catalog version, in
// ascending order. `0019` is the frozen v1 baseline; every later entry is an
// incremental delta (only the rows whose `since` equals that version). To
// publish a new catalog version: tag the new/changed core row(s) with a
// template/layout `version` (or a `since_version` on other row kinds) one
// higher than today's latest, append one entry here naming the next
// contiguous ordered-migration slot, and regenerate. Earlier entries are
// never rewritten — `writeGeneratedArtifacts` refuses to touch an existing
// migration file whose bytes would change.
const CATALOG_MIGRATIONS = [
  { version: 1, name: '0019__journal_catalog_v1.sql' },
  { version: 2, name: '0022__journal_catalog_v2.sql' },
  { version: 3, name: '0023__journal_catalog_v3.sql' },
];

const TABLE_ORDER = [
  'journal_vocab',
  'journal_vocab_mappings',
  'journal_templates',
  'journal_layouts',
  'journal_products',
];

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) =>
      JSON.stringify(key) + ':' + stableStringify(value[key])
    ).join(',') + '}';
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`cannot emit non-finite SQL number: ${value}`);
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  return "'" + String(value).replace(/'/g, "''") + "'";
}

// A row introduced at catalog version N must only (re-)insert itself while
// the installed catalog hasn't moved past N yet — this is a defense-in-depth
// guard on top of the NOT EXISTS idempotency check below, not the primary
// idempotency mechanism. Reproduces the historical v1 predicate
// (`<= 1`) exactly for since=1 rows, so 0019 stays byte-identical.
function catalogActiveGuard(sinceVersion) {
  assert(Number.isInteger(sinceVersion) && sinceVersion >= 1, `invalid since version ${sinceVersion}`);
  return `COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= ${sinceVersion}`;
}

const ROW_IDENTITY_COLUMNS = {
  journal_vocab: ['code'],
  journal_vocab_mappings: ['term_code', 'scheme_uri', 'mapping_role', 'external_id'],
  journal_templates: ['code', 'version'],
  journal_layouts: ['code', 'version'],
  journal_products: ['product_uuid'],
};

function insertIfCatalogNotNewer(row) {
  const identity = ROW_IDENTITY_COLUMNS[row.table];
  assert(identity, `no immutable row identity declared for ${row.table}`);
  const identityPredicate = identity.map((column) => {
    const index = row.columns.indexOf(column);
    assert(index !== -1, `${row.table} row is missing identity column ${column}`);
    return exactColumnPredicate(column, row.values[index]);
  }).join(' AND ');
  return [
    `INSERT INTO ${row.table}(${row.columns.join(',')})`,
    `SELECT ${row.values.map(sqlValue).join(',')}`,
    `WHERE ${catalogActiveGuard(row.since)}`,
    `  AND NOT EXISTS (SELECT 1 FROM ${row.table} WHERE ${identityPredicate});`,
  ].join('\n');
}

function exactColumnPredicate(column, value) {
  return value === null || value === undefined
    ? `${column} IS NULL`
    : `${column}=${sqlValue(value)}`;
}

function postconditionGuard(row) {
  const exact = row.columns.map((column, index) =>
    exactColumnPredicate(column, row.values[index])
  ).join(' AND ');
  return [
    'INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)',
    `SELECT 0,0,${sqlValue(`catalog-v${row.since}-postcondition-failed`)},${sqlValue(FIXED_TIMESTAMP)}`,
    `WHERE ${catalogActiveGuard(row.since)}`,
    `  AND NOT EXISTS (SELECT 1 FROM ${row.table} WHERE ${exact});`,
  ].join('\n');
}

// Rows outside `journal_templates`/`journal_layouts` don't carry their own
// `version`; they default to catalog version 1 (matching every row that
// existed when v1 was generated) unless the core object explicitly opts a
// future row into a later version via `since_version`.
function rowSince(sourceObject) {
  const since = sourceObject && sourceObject.since_version;
  if (since == null) return 1;
  assert(
    Number.isInteger(since) && since >= 1,
    `invalid since_version on ${(sourceObject && sourceObject.code) || '(unknown)'}`
  );
  return since;
}

function humanize(code) {
  return String(code)
    .split('_')
    .map((part) => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join(' ');
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function deterministicUuid(namespace, code) {
  const bytes = Buffer.from(sha256(`${namespace}:${code}`).slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function repairedDevices(operation) {
  const devices = [];
  const seen = new Set();
  for (const device of operation.devices) {
    if (seen.has(device.code)) continue;
    seen.add(device.code);
    devices.push(device);
  }
  if (operation.code === 'cleaning_cut' && !seen.has('mower')) {
    devices.push({
      code: 'mower',
      units: [],
      description: 'An agricultural implement used to cut grass or other ground vegetation.',
      source: 'AGROVOC',
    });
  }
  return devices;
}

function categoryActivityMap(coreDef) {
  const result = new Map();
  for (const activity of coreDef.activities) {
    for (const categoryCode of activity.agroscope_categories || []) {
      assert(!result.has(categoryCode), `duplicate Agroscope category binding ${categoryCode}`);
      result.set(categoryCode, activity.code);
    }
  }
  return result;
}

function bindingFor(coreDef, categoryCode, sourceUnit) {
  const matches = [];
  for (const unit of coreDef.units) {
    for (const binding of unit.source_bindings || []) {
      if (binding.label !== sourceUnit || !binding.categories.includes(categoryCode)) continue;
      matches.push([binding.target_attribute_code, unit.code]);
    }
  }
  assert(
    matches.length === 1,
    `expected exactly one semantic binding for Agroscope ${categoryCode}/${sourceUnit}, found ${matches.length}`
  );
  return matches[0];
}

function validateCore(coreDef) {
  assert(Object.keys(coreDef).join(',') === 'activities,attributes,units,choices,templates,layouts,products',
    'core export must contain exactly the seven catalog collections in contract order');
  assert(coreDef.activities.length === 16, 'core must define exactly 16 activities');
  assert(
    new Set(coreDef.templates.map((row) => row.code)).size === 3,
    'core must define exactly three distinct template codes (any number of versions each)'
  );
  assert(
    new Set(coreDef.layouts.map((row) => row.code)).size === 3,
    'core must define exactly three distinct generic layout codes (any number of versions each)'
  );

  const templateVersionsByCode = new Map();
  for (const template of coreDef.templates) {
    assert(Number.isInteger(template.version) && template.version >= 1,
      `${template.code} has an invalid version`);
    const seenVersions = templateVersionsByCode.get(template.code) || new Set();
    assert(!seenVersions.has(template.version),
      `duplicate template version ${template.code}@${template.version}`);
    seenVersions.add(template.version);
    templateVersionsByCode.set(template.code, seenVersions);
  }
  const layoutVersionsByCode = new Map();
  for (const layout of coreDef.layouts) {
    assert(Number.isInteger(layout.version) && layout.version >= 1,
      `${layout.code} has an invalid version`);
    const seenVersions = layoutVersionsByCode.get(layout.code) || new Set();
    assert(!seenVersions.has(layout.version),
      `duplicate layout version ${layout.code}@${layout.version}`);
    seenVersions.add(layout.version);
    layoutVersionsByCode.set(layout.code, seenVersions);
  }

  const unitByCode = new Map(coreDef.units.map((row) => [row.code, row]));
  const attributeByCode = new Map(coreDef.attributes.map((row) => [row.code, row]));
  const allCodes = new Set();
  for (const row of [
    ...coreDef.activities,
    ...coreDef.attributes,
    ...coreDef.units,
    ...coreDef.choices,
  ]) {
    assert(!allCodes.has(row.code), `duplicate core vocab code ${row.code}`);
    allCodes.add(row.code);
  }
  for (const attribute of coreDef.attributes.filter((row) => row.value_type === 'number')) {
    assert(attribute.quantity_kind, `${attribute.code} missing quantity_kind`);
    assert(attribute.basis, `${attribute.code} missing basis`);
    if (attribute.constraints?.allow_default_unit === false) {
      assert(attribute.default_unit_code == null,
        `${attribute.code} forbids a default unit but defines ${attribute.default_unit_code}`);
      assert(attribute.constraints.requires_explicit_unit === true,
        `${attribute.code} without a default unit must require an explicit unit`);
      continue;
    }
    assert(unitByCode.has(attribute.default_unit_code),
      `${attribute.code} has unknown default unit ${attribute.default_unit_code}`);
    const defaultUnit = unitByCode.get(attribute.default_unit_code);
    assert(defaultUnit.quantity_kind === attribute.quantity_kind,
      `${attribute.code} quantity_kind does not match ${attribute.default_unit_code}`);
    assert(defaultUnit.basis === attribute.basis,
      `${attribute.code} basis does not match ${attribute.default_unit_code}`);
    assert(defaultUnit.to_canonical.unit_code === defaultUnit.code &&
      defaultUnit.to_canonical.scale === 1 && defaultUnit.to_canonical.offset === 0,
    `${attribute.code} default_unit_code must name the canonical storage unit`);
  }
  const canonicalByFamily = new Map();
  for (const unit of coreDef.units) {
    assert(unit.quantity_kind && unit.basis && unit.dimension, `${unit.code} has incomplete dimensional semantics`);
    assert(unit.to_canonical && Number.isFinite(unit.to_canonical.scale) && Number.isFinite(unit.to_canonical.offset),
      `${unit.code} has invalid to_canonical conversion`);
    assert(unitByCode.has(unit.to_canonical.unit_code), `${unit.code} converts to unknown ${unit.to_canonical.unit_code}`);
    const canonical = unitByCode.get(unit.to_canonical.unit_code);
    assert(canonical.quantity_kind === unit.quantity_kind && canonical.basis === unit.basis && canonical.dimension === unit.dimension,
      `${unit.code} converts across an incompatible unit family`);
    assert(canonical.to_canonical.unit_code === canonical.code && canonical.to_canonical.scale === 1 && canonical.to_canonical.offset === 0,
      `${unit.code} canonical target ${canonical.code} is not a canonical root`);
    const family = `${unit.quantity_kind}\u0000${unit.basis}\u0000${unit.dimension}`;
    if (!canonicalByFamily.has(family)) canonicalByFamily.set(family, canonical.code);
    assert(canonicalByFamily.get(family) === canonical.code,
      `${unit.code} disagrees on the canonical target for its unit family`);
    for (const binding of unit.source_bindings || []) {
      assert(typeof binding.label === 'string' && binding.label,
        `${unit.code} has an invalid source binding label`);
      assert(attributeByCode.has(binding.target_attribute_code),
        `${unit.code} source binding targets unknown ${binding.target_attribute_code}`);
      assert(Array.isArray(binding.categories) && binding.categories.length > 0,
        `${unit.code} source binding ${binding.label} has no source categories`);
      const target = attributeByCode.get(binding.target_attribute_code);
      assert(target.quantity_kind === unit.quantity_kind && target.basis === unit.basis,
        `${unit.code} source binding ${binding.label} targets an incompatible attribute`);
    }
  }
  for (const choice of coreDef.choices) {
    assert(attributeByCode.has(choice.parent_code), `${choice.code} has unknown parent ${choice.parent_code}`);
  }
  for (const activity of coreDef.activities) {
    for (const mapping of activity.mappings || []) {
      assert(mapping.scheme_uri && mapping.scheme_version && mapping.mapping_role,
        `${activity.code} has an incomplete standard mapping`);
      assert(mapping.external_id && mapping.mapping_relation && mapping.source_uri,
        `${activity.code} has an incomplete standard mapping target`);
    }
  }
  validateQuickFieldsAndReadings(coreDef);
}

// Slice BC (journal-catalog v3): a template's `quick_fields` is an
// activity_code -> field-code map consumed by templateEngine.deriveFieldStates
// to scope the Quick capture form per activity (R1). Every core activity must
// be covered so the model never silently falls through to a bare default at
// render time, and every referenced field code must be a real attribute (or
// the top-level `note` field) — a typo here would otherwise only surface as a
// runtime GUI bug. Layout `reading_fields`/`static_context_fields` get the
// analogous check: every referenced field must be a real attribute, no
// `reading_fields` entry may remain in that same layout's `minimum_fields`
// (BC3's whole point — readings move to the `sampling` Quick set instead of
// being forced onto every entry), and `static_context_fields` must be a
// subset of `minimum_fields` (it is the same forced set full_record/research
// still see, just also exposed for read-only plot-context rendering).
function validateQuickFieldsAndReadings(coreDef) {
  const attributeCodes = new Set(coreDef.attributes.map((row) => row.code));
  const activityCodes = new Set(coreDef.activities.map((row) => row.code));
  const knownQuickField = (code) => code === 'note' || attributeCodes.has(code);

  for (const template of coreDef.templates) {
    const quickFields = template.definition && template.definition.quick_fields;
    if (quickFields == null) continue;
    assert(template.code === 'farmer_quick',
      `only farmer_quick may declare quick_fields (found on ${template.code}@${template.version})`);
    const declared = Object.keys(quickFields);
    assert(
      declared.length === activityCodes.size && declared.every((code) => activityCodes.has(code)),
      `${template.code}@${template.version} quick_fields must cover exactly every core activity`
    );
    for (const [activityCode, fields] of Object.entries(quickFields)) {
      assert(Array.isArray(fields) && fields.length > 0,
        `${template.code}@${template.version} quick_fields.${activityCode} must be a nonempty array`);
      for (const field of fields) {
        assert(knownQuickField(field),
          `${template.code}@${template.version} quick_fields.${activityCode} references unknown field ${field}`);
      }
    }
  }

  for (const layout of coreDef.layouts) {
    const definition = layout.definition || {};
    const readingFields = definition.reading_fields || [];
    const staticFields = definition.static_context_fields || [];
    const minimumFields = definition.minimum_fields || [];
    for (const field of [...readingFields, ...staticFields]) {
      assert(attributeCodes.has(field),
        `${layout.code}@${layout.version} references unknown field ${field}`);
    }
    const readingsStillMinimum = readingFields.filter((field) => minimumFields.includes(field));
    assert(readingsStillMinimum.length === 0,
      `${layout.code}@${layout.version} minimum_fields must not retain reading field(s) ${readingsStillMinimum.join(', ')}`);
    const staticNotMinimum = staticFields.filter((field) => !minimumFields.includes(field));
    assert(staticNotMinimum.length === 0,
      `${layout.code}@${layout.version} static_context_fields must be a subset of minimum_fields (missing ${staticNotMinimum.join(', ')})`);
  }
}

function validateSource(coreDef, source) {
  assert(source.categories.length === 7, 'Agroscope source must contain seven categories');
  const operations = source.categories.flatMap((category) => category.operations);
  const sourceSlots = operations.reduce((count, operation) => count + operation.devices.length, 0);
  assert(operations.length === 25, 'Agroscope source must contain 25 operations');
  assert(source.counts.device_slots === 128 && sourceSlots === 128,
    'Agroscope source must retain all 128 extracted device slots');
  const categoryActivities = categoryActivityMap(coreDef);
  assert(categoryActivities.size === 7, 'core category mapping must contain exactly seven categories');
  for (const category of source.categories) {
    assert(categoryActivities.has(category.code), `unmapped Agroscope category ${category.code}`);
  }
  const sourceProducts = new Set(source.product_suggestions);
  for (const product of coreDef.products) {
    assert(sourceProducts.has(product.name), `core product is not source-supported: ${product.name}`);
    assert(Object.keys(product.composition).length === 0,
      `source has no defensible composition for ${product.name}; composition must stay empty`);
  }
  const declaredUnits = new Set(source.all_units);
  for (const category of source.categories) {
    const categoryUnits = new Set(category.operations.flatMap((operation) =>
      operation.devices.flatMap((device) => device.units)
    ));
    for (const sourceUnit of categoryUnits) {
      assert(declaredUnits.has(sourceUnit),
        `Agroscope category ${category.code} uses undeclared unit ${sourceUnit}`);
      bindingFor(coreDef, category.code, sourceUnit);
    }
  }
  for (const sourceUnit of declaredUnits) {
    assert(source.categories.some((category) => category.operations.some((operation) =>
      operation.devices.some((device) => device.units.includes(sourceUnit))
    )), `source unit ${sourceUnit} is declared but unused`);
  }
}

function buildAgroscope(coreDef, source) {
  const categoryActivities = categoryActivityMap(coreDef);
  const choices = [];
  const dependencies = [];
  const deviceMetadata = new Map();
  let operationSort = 1000;
  let deviceSort = 2000;

  for (const category of source.categories) {
    const operationChoices = [];
    for (const operation of category.operations) {
      const operationCode = `agroscope.operation.${operation.code}`;
      operationChoices.push(operationCode);
      choices.push({
        code: operationCode,
        parent_code: 'attr.agroscope.operation',
        label: humanize(operation.code),
        sort_order: operationSort++,
        metadata: {
          description: operation.description || '',
          source: operation.source || '',
          source_category: category.code,
        },
      });

      const devices = repairedDevices(operation);
      const deviceChoices = [];
      for (const device of devices) {
        const deviceCode = `agroscope.device.${device.code}`;
        deviceChoices.push(deviceCode);
        if (!deviceMetadata.has(device.code)) {
          deviceMetadata.set(device.code, {
            units: device.units,
            sourceCategories: new Set(),
            descriptions: new Set(),
            sources: new Set(),
          });
        }
        const metadata = deviceMetadata.get(device.code);
        assert(stableStringify(metadata.units) === stableStringify(device.units),
          `device ${device.code} has inconsistent source unit sets`);
        metadata.sourceCategories.add(category.code);
        if (device.description) metadata.descriptions.add(device.description);
        if (device.source) metadata.sources.add(device.source);
      }
      dependencies.push({
        when: { attribute_code: 'attr.agroscope.operation', equals: operationCode },
        restrict: { attribute_code: 'attr.agroscope.device', choices: deviceChoices },
      });
    }
    dependencies.push({
      source_category: category.code,
      when: { attribute_code: 'activity_code', equals: categoryActivities.get(category.code) },
      restrict: { attribute_code: 'attr.agroscope.operation', choices: operationChoices },
    });
  }

  // Category rules must precede operation rules in the stored JSON only for
  // readability; the validator selects them by their explicit attributes.
  const categoryDependencies = dependencies.filter((rule) => rule.source_category);
  const operationDependencies = dependencies.filter((rule) => !rule.source_category);
  const unitDependencies = [];

  for (const [device, metadata] of deviceMetadata) {
    choices.push({
      code: `agroscope.device.${device}`,
      parent_code: 'attr.agroscope.device',
      label: humanize(device),
      sort_order: deviceSort++,
      metadata: {
        descriptions: [...metadata.descriptions],
        sources: [...metadata.sources],
      },
    });
    const byAttribute = new Map();
    for (const sourceUnit of metadata.units) {
      const bindings = [...metadata.sourceCategories].map((categoryCode) =>
        bindingFor(coreDef, categoryCode, sourceUnit)
      );
      const [attributeCode, unitCode] = bindings[0];
      assert(bindings.every((binding) => stableStringify(binding) === stableStringify(bindings[0])),
        `device ${device}/${sourceUnit} has category-dependent semantics that cannot be device-scoped`);
      if (!byAttribute.has(attributeCode)) byAttribute.set(attributeCode, []);
      const allowed = byAttribute.get(attributeCode);
      if (!allowed.includes(unitCode)) allowed.push(unitCode);
    }
    for (const [attributeCode, allowedUnits] of byAttribute) {
      unitDependencies.push({
        when: { attribute_code: 'attr.agroscope.device', equals: `agroscope.device.${device}` },
        restrict: { attribute_code: attributeCode, units: allowedUnits },
      });
    }
  }

  let cropSort = 3000;
  for (const crop of source.crop_list) {
    choices.push({
      code: `agroscope.crop.${slug(crop)}`,
      parent_code: 'attr.crop',
      label: crop,
      sort_order: cropSort++,
      metadata: { source: 'SoilManageR management-data template v2.6' },
    });
  }

  return {
    choices,
    layout: {
      code: 'agroscope_open_field',
      version: 1,
      label: 'Agroscope open field',
      definition: {
        source: {
          name: 'SoilManageR management-data template',
          version: '2.6',
          date: '2024-12-23',
          license: 'CC BY',
          attribution: 'Wittwer, Heller, Turek — Agroscope',
        },
        activity_codes: source.categories.map((category) => categoryActivities.get(category.code)),
        supported_templates: ['research_observation'],
        fields: [
          'attr.crop',
          'attr.agroscope.operation',
          'attr.agroscope.device',
          'attr.amount_operation_depth',
          'attr.amount_mass_area_product',
          'attr.amount_volume_area_product',
          'attr.amount_nutrient_rate',
          'attr.amount_count_area',
          'attr.amount_biological_count_area',
          'attr.amount_duration_area',
          'attr.irrigation_volume_area',
          'attr.machine',
          'attr.product_uuid',
          'attr.product',
          'attr.agroscope.combination_group',
          'attr.agroscope.dmc_mass_fraction',
          'attr.agroscope.dmc_mass_volume',
          'attr.agroscope.c_content',
          'attr.agroscope.n_content',
          'attr.agroscope.crop_product',
          'attr.agroscope.crop_residue',
          'attr.agroscope.cc_product',
          'attr.agroscope.cc_residue',
        ],
        treatment_factors: source.treatment_factors,
        option_dependencies: [
          ...categoryDependencies,
          ...operationDependencies,
          ...unitDependencies,
        ],
      },
    },
  };
}

function vocabRow(row) {
  const columns = [
    'code', 'kind', 'parent_code', 'value_type', 'quantity_kind', 'basis',
    'default_unit_code', 'labels_json', 'icon_key', 'constraints_json',
    'scope', 'active', 'sort_order', 'sync_version', 'created_at',
  ];
  return {
    table: 'journal_vocab',
    key: row.code,
    columns,
    values: [
      row.code,
      row.kind,
      row.parent_code || null,
      row.value_type || null,
      row.quantity_kind || null,
      row.basis || null,
      row.default_unit_code || null,
      JSON.stringify({ en: row.label }),
      row.icon_key || null,
      row.constraints == null ? null : JSON.stringify(row.constraints),
      'core',
      1,
      row.sort_order || 0,
      0,
      FIXED_TIMESTAMP,
    ],
    since: rowSince(row),
  };
}

function buildRows(coreDef, source) {
  validateCore(coreDef);
  validateSource(coreDef, source);
  const agroscope = buildAgroscope(coreDef, source);
  const rows = [];

  for (const activity of coreDef.activities) {
    rows.push(vocabRow({ ...activity, kind: 'activity' }));
  }
  let attributeSort = 100;
  for (const attribute of coreDef.attributes) {
    rows.push(vocabRow({ ...attribute, kind: 'attribute', sort_order: attributeSort++ }));
  }
  let unitSort = 500;
  for (const sourceUnit of coreDef.units) {
    const constraints = {
      dimension: sourceUnit.dimension,
      to_canonical: sourceUnit.to_canonical,
    };
    if (sourceUnit.nutrient) constraints.nutrient = sourceUnit.nutrient;
    rows.push(vocabRow({
      ...sourceUnit,
      kind: 'unit',
      constraints,
      sort_order: unitSort++,
    }));
  }
  for (const coreChoice of coreDef.choices) {
    rows.push(vocabRow({
      ...coreChoice,
      kind: 'choice',
      constraints: null,
    }));
  }
  for (const sourceChoice of agroscope.choices) {
    rows.push(vocabRow({
      ...sourceChoice,
      kind: 'choice',
      constraints: sourceChoice.metadata,
    }));
  }

  for (const activity of coreDef.activities) {
    for (const mapping of activity.mappings || []) {
      const columns = [
        'term_code', 'scheme_uri', 'scheme_version', 'mapping_role', 'external_id',
        'external_parent_id', 'mapping_relation', 'source_uri', 'active',
      ];
      rows.push({
        table: 'journal_vocab_mappings',
        key: [activity.code, mapping.scheme_uri, mapping.mapping_role, mapping.external_id]
          .join(':'),
        columns,
        values: [
          activity.code,
          mapping.scheme_uri,
          mapping.scheme_version,
          mapping.mapping_role,
          mapping.external_id,
          mapping.external_parent_id || null,
          mapping.mapping_relation,
          mapping.source_uri,
          mapping.active,
        ],
        since: rowSince(activity),
      });
    }
  }

  for (const template of coreDef.templates) {
    rows.push({
      table: 'journal_templates',
      key: `${template.code}:${template.version}`,
      columns: ['code', 'version', 'labels_json', 'definition_json', 'active'],
      values: [template.code, template.version, JSON.stringify({ en: template.label }), JSON.stringify(template.definition), 1],
      since: template.version,
    });
  }
  for (const layout of [...coreDef.layouts, agroscope.layout]) {
    rows.push({
      table: 'journal_layouts',
      key: `${layout.code}:${layout.version}`,
      columns: ['code', 'version', 'labels_json', 'definition_json', 'active'],
      values: [layout.code, layout.version, JSON.stringify({ en: layout.label }), JSON.stringify(layout.definition), 1],
      since: layout.version,
    });
  }
  for (const product of coreDef.products) {
    rows.push({
      table: 'journal_products',
      key: product.code,
      columns: [
        'product_uuid', 'scope', 'name', 'kind', 'composition_json', 'active',
        'sync_version', 'created_at',
      ],
      values: [
        deterministicUuid('osi-journal-product-v1', product.code),
        'core',
        product.name,
        product.kind,
        JSON.stringify(product.composition),
        1,
        0,
        FIXED_TIMESTAMP,
      ],
      since: rowSince(product),
    });
  }

  const vocabCodes = new Set(rows.filter((row) => row.table === 'journal_vocab').map((row) => row.key));
  assert(vocabCodes.size === rows.filter((row) => row.table === 'journal_vocab').length,
    'generated vocab codes must be unique');
  for (const sourceUnit of source.all_units) {
    const categories = source.categories.filter((category) =>
      category.operations.some((operation) => operation.devices.some((device) => device.units.includes(sourceUnit)))
    );
    assert(categories.length > 0, `source unit ${sourceUnit} is declared but unused`);
    for (const category of categories) {
      const [attributeCode, unitCode] = bindingFor(coreDef, category.code, sourceUnit);
      assert(vocabCodes.has(attributeCode), `missing generated amount attribute ${attributeCode}`);
      assert(vocabCodes.has(unitCode), `missing generated unit ${unitCode}`);
    }
  }
  return rows;
}

function catalogRowsHash(rowsSubset) {
  const hashInput = rowsSubset.map((row) => ({
    table: row.table,
    key: row.key,
    columns: row.columns,
    values: row.values,
  }));
  return sha256(stableStringify(hashInput));
}

// Renders INSERT statements (grouped by table, tables with no rows in this
// slice are omitted) plus postcondition guards for exactly `rowsSubset`, and
// optionally a `journal_catalog_state` stamp to `stampVersion`/`stampHash`.
// Used both for a single version's delta migration (rowsSubset = only that
// version's new rows) and for the full cumulative seed block (rowsSubset =
// every row, stamped to the latest version).
function buildRowSql(rowsSubset, { commentVersion, includeStateStamp, stampVersion, stampHash }) {
  const sections = [];
  for (const table of TABLE_ORDER) {
    const tableRows = rowsSubset.filter((row) => row.table === table);
    if (tableRows.length === 0) continue;
    sections.push(`-- ${table}`);
    for (const row of tableRows) sections.push(insertIfCatalogNotNewer(row));
    sections.push('');
  }
  if (rowsSubset.length > 0) {
    sections.push(`-- Immutable v${commentVersion} postconditions. Each mismatch deliberately attempts id=0,`);
    sections.push('-- tripping journal_catalog_state CHECK(id=1) before state can be stamped.');
    for (const row of rowsSubset) sections.push(postconditionGuard(row));
    sections.push('');
  }
  if (includeStateStamp) {
    sections.push('-- journal_catalog_state');
    sections.push(
      `INSERT OR IGNORE INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at) VALUES (1,${stampVersion},${sqlValue(stampHash)},${sqlValue(FIXED_TIMESTAMP)});`
    );
    sections.push(
      `UPDATE journal_catalog_state SET catalog_version=${stampVersion},catalog_hash=${sqlValue(stampHash)},updated_at=${sqlValue(FIXED_TIMESTAMP)} WHERE id=1 AND catalog_version <= ${stampVersion};`
    );
  }
  return sections.join('\n').trimEnd() + '\n';
}

// Compiles the full current catalog into: every generated row (each carrying
// the catalog version it was introduced `since`), one migration per
// registered catalog version (a pure delta: only that version's new rows),
// and the seed block (the full cumulative state, for bootstrapping a fresh
// database in one shot). `migrationsRegistry` defaults to the real
// CATALOG_MIGRATIONS list; tests may pass an extended copy to prove a
// hypothetical next version stays a pure delta without touching this file.
function compileCatalog(coreDef, source, migrationsRegistry = CATALOG_MIGRATIONS) {
  const rows = buildRows(coreDef, source);
  const versions = [...new Set(rows.map((row) => row.since))].sort((left, right) => left - right);
  versions.forEach((version, index) => {
    assert(version === index + 1,
      `catalog row versions must be contiguous starting at 1 (found gap before version ${version})`);
  });
  const registryByVersion = new Map(migrationsRegistry.map((entry) => [entry.version, entry]));

  const migrations = versions.map((version) => {
    const entry = registryByVersion.get(version);
    assert(entry,
      `no CATALOG_MIGRATIONS entry declared for catalog version ${version}; add one before publishing new core content`);
    const deltaRows = rows.filter((row) => row.since === version);
    const cumulativeRows = rows.filter((row) => row.since <= version);
    const stampHash = catalogRowsHash(cumulativeRows);
    const rowSql = buildRowSql(deltaRows, {
      commentVersion: version,
      includeStateStamp: true,
      stampVersion: version,
      stampHash,
    });
    const content = [
      '-- risk: data',
      '-- GENERATED by scripts/generate-journal-catalog.js; do not edit by hand.',
      '-- Source: SoilManageR management-data template v2.6 + scripts/journal-catalog-core.js.',
      `-- catalog-row-content-sha256: ${catalogRowsHash(deltaRows)}`,
      '',
      rowSql.trimEnd(),
      '',
    ].join('\n');
    return { version, name: entry.name, content, stampHash };
  });

  const latest = migrations[migrations.length - 1];
  const seedRowSql = buildRowSql(rows, {
    commentVersion: latest.version,
    includeStateStamp: true,
    stampVersion: latest.version,
    stampHash: latest.stampHash,
  });
  const seedBlock = `${SEED_BEGIN}\n${seedRowSql}${SEED_END}\n`;
  return { rows, catalogHash: latest.stampHash, migrations, seedBlock };
}

function replaceSeedBlock(seed, seedBlock) {
  const beginCount = seed.split(SEED_BEGIN).length - 1;
  const endCount = seed.split(SEED_END).length - 1;
  if (beginCount === 0 && endCount === 0) {
    return seed.trimEnd() + '\n\n' + seedBlock;
  }
  if (beginCount !== 1 || endCount !== 1) {
    fail(beginCount > 1 || endCount > 1
      ? 'seed contains more than one generated journal catalog marker block'
      : 'seed contains an incomplete generated journal catalog marker block');
  }
  const start = seed.indexOf(SEED_BEGIN);
  const end = seed.indexOf(SEED_END);
  if (end < start) {
    fail('seed contains an incomplete generated journal catalog marker block');
  }
  const after = end + SEED_END.length;
  return seed.slice(0, start) + seedBlock.trimEnd() + seed.slice(after);
}

function expectedManifestText(manifest, migrations) {
  const next = { ...manifest };
  for (const migration of migrations) next[migration.name] = sha256(migration.content);
  const ordered = Object.fromEntries(Object.entries(next).sort(([left], [right]) => left.localeCompare(right)));
  return JSON.stringify(ordered, null, 2) + '\n';
}

function checkEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label} is stale; run node scripts/generate-journal-catalog.js`);
  }
}

function artifactPaths(overrides = {}) {
  return {
    migrationsDir: overrides.migrationsDir || MIGRATIONS_DIR,
    seedPath: overrides.seedPath || SEED_PATH,
    manifestPath: overrides.manifestPath || MANIFEST_PATH,
  };
}

function expectedArtifacts(compiled, overrides = {}) {
  const paths = artifactPaths(overrides);
  const currentSeed = fs.readFileSync(paths.seedPath, 'utf8');
  const expectedSeed = replaceSeedBlock(currentSeed, compiled.seedBlock);
  const manifest = JSON.parse(fs.readFileSync(paths.manifestPath, 'utf8'));
  const migrationChecks = compiled.migrations.map((migration) => ({
    name: migration.name,
    path: path.join(paths.migrationsDir, migration.name),
    content: migration.content,
    checksum: sha256(migration.content),
  }));
  return {
    paths,
    manifest,
    migrationChecks,
    expectedSeed,
    expectedManifest: expectedManifestText(manifest, compiled.migrations),
  };
}

function checkGeneratedArtifacts(compiled, overrides = {}) {
  const { paths, migrationChecks, expectedSeed, expectedManifest } = expectedArtifacts(compiled, overrides);
  for (const migration of migrationChecks) {
    checkEqual(
      fs.existsSync(migration.path) ? fs.readFileSync(migration.path, 'utf8') : '',
      migration.content,
      migration.name
    );
  }
  checkEqual(fs.readFileSync(paths.seedPath, 'utf8'), expectedSeed,
    path.basename(paths.seedPath) + ' generated catalog block');
  checkEqual(fs.readFileSync(paths.manifestPath, 'utf8'), expectedManifest,
    path.basename(paths.manifestPath) + ' journal catalog checksum');
}

function writeGeneratedArtifacts(compiled, overrides = {}) {
  const {
    paths,
    manifest,
    migrationChecks,
    expectedSeed,
    expectedManifest,
  } = expectedArtifacts(compiled, overrides);

  // Validate every migration before writing any of them, so a refusal on one
  // migration never leaves a partial write behind on another.
  for (const migration of migrationChecks) {
    const exists = fs.existsSync(migration.path);
    if (exists) {
      const installed = fs.readFileSync(migration.path, 'utf8');
      if (installed !== migration.content) {
        fail(`${migration.name} exists and differs; refuse to rewrite an immutable migration — create a new migration`);
      }
    } else {
      const recordedChecksum = manifest[migration.name];
      if (recordedChecksum && recordedChecksum !== migration.checksum) {
        fail(`${migration.name} has a different recorded checksum; restore it or create a new migration`);
      }
    }
  }
  for (const migration of migrationChecks) {
    if (!fs.existsSync(migration.path)) fs.writeFileSync(migration.path, migration.content);
  }
  if (fs.readFileSync(paths.seedPath, 'utf8') !== expectedSeed) {
    fs.writeFileSync(paths.seedPath, expectedSeed);
  }
  if (fs.readFileSync(paths.manifestPath, 'utf8') !== expectedManifest) {
    fs.writeFileSync(paths.manifestPath, expectedManifest);
  }
}

function main(argv) {
  const check = argv.length === 1 && argv[0] === '--check';
  if (argv.length && !check) fail(`unsupported argument(s): ${argv.join(' ')}`);

  const source = JSON.parse(fs.readFileSync(SOURCE_PATH, 'utf8'));
  const compiled = compileCatalog(core, source);

  if (check) {
    checkGeneratedArtifacts(compiled);
    console.log(`generate-journal-catalog: OK (${compiled.catalogHash})`);
    return;
  }

  writeGeneratedArtifacts(compiled);
  console.log(`generate-journal-catalog: artifacts current (${compiled.catalogHash})`);
}

module.exports = {
  compileCatalog,
  validateCore,
  validateSource,
  replaceSeedBlock,
  expectedManifestText,
  writeGeneratedArtifacts,
  CATALOG_MIGRATIONS,
};

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`generate-journal-catalog: FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
