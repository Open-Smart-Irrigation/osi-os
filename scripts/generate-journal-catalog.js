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
const MIGRATION_NAME = '0015__journal_catalog_v1.sql';
const MIGRATION_PATH = path.join(REPO_ROOT, 'database/migrations/ordered', MIGRATION_NAME);
const MANIFEST_PATH = path.join(REPO_ROOT, 'database/migrations/ordered/CHECKSUMS.json');
const SEED_PATH = path.join(REPO_ROOT, 'database/seed-blank.sql');
const SEED_BEGIN = '-- BEGIN GENERATED JOURNAL CATALOG V1';
const SEED_END = '-- END GENERATED JOURNAL CATALOG V1';
const CATALOG_VERSION = 1;
const FIXED_TIMESTAMP = '2026-07-12T00:00:00.000Z';

const CATEGORY_ACTIVITY = {
  tillage: 'tillage_soil_work',
  sowing: 'seeding',
  fertilizer_application: 'fertilization',
  crop_protection: 'plant_protection_application',
  harvest: 'harvest',
  irrigation: 'irrigation',
  other: 'general_observation',
};

const UNIT_BINDINGS = {
  cm: ['attr.amount_operation_depth', 'unit.cm_operation_depth'],
  'g/ha': ['attr.amount_mass_area_product', 'unit.g_per_ha_product'],
  'hours/ha': ['attr.amount_duration_area', 'unit.h_per_ha_labor'],
  'kg B/ha': ['attr.amount_nutrient_rate', 'unit.kg_b_per_ha_nutrient'],
  'kg Ca/ha': ['attr.amount_nutrient_rate', 'unit.kg_ca_per_ha_nutrient'],
  'kg CaO/ha': ['attr.amount_nutrient_rate', 'unit.kg_cao_per_ha_nutrient'],
  'kg K2O/ha': ['attr.amount_nutrient_rate', 'unit.kg_k2o_per_ha_nutrient'],
  'kg Mg/ha': ['attr.amount_nutrient_rate', 'unit.kg_mg_per_ha_nutrient'],
  'kg Mn/ha': ['attr.amount_nutrient_rate', 'unit.kg_mn_per_ha_nutrient'],
  'kg N/ha': ['attr.amount_nutrient_rate', 'unit.kg_n_per_ha_nutrient'],
  'kg Na/ha': ['attr.amount_nutrient_rate', 'unit.kg_na_per_ha_nutrient'],
  'kg P2O5/ha': ['attr.amount_nutrient_rate', 'unit.kg_p2o5_per_ha_nutrient'],
  'kg S/ha': ['attr.amount_nutrient_rate', 'unit.kg_s_per_ha_nutrient'],
  'kg/ha': ['attr.amount_mass_area_product', 'unit.kg_per_ha_product'],
  'l/ha': ['attr.amount_volume_area_product', 'unit.l_per_ha_product'],
  'plants/ha': ['attr.amount_count_area', 'unit.plants_per_ha'],
  't/ha': ['attr.amount_mass_area_product', 'unit.t_per_ha_product'],
  'unit/ha': ['attr.amount_biological_count_area', 'unit.biological_count_per_ha'],
};

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

function insertOrIgnore(table, columns, values) {
  return `INSERT OR IGNORE INTO ${table}(${columns.join(',')}) VALUES (${values.map(sqlValue).join(',')});`;
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

function bindingFor(categoryCode, sourceUnit) {
  if (sourceUnit === 'm3/ha') {
    return categoryCode === 'irrigation'
      ? ['attr.irrigation_volume_area', 'unit.m3_per_ha_water']
      : ['attr.amount_volume_area_product', 'unit.m3_per_ha_product'];
  }
  const binding = UNIT_BINDINGS[sourceUnit];
  if (!binding) fail(`no semantic binding for Agroscope unit ${sourceUnit}`);
  return binding;
}

function validateCore() {
  assert(Object.keys(core).join(',') === 'activities,attributes,units,choices,templates,layouts,products',
    'core export must contain exactly the seven catalog collections in contract order');
  assert(core.activities.length === 16, 'core must define exactly 16 activities');
  assert(core.templates.length === 3, 'core must define exactly three templates');
  assert(core.layouts.length === 3, 'core must define exactly three generic layouts');

  const unitByCode = new Map(core.units.map((row) => [row.code, row]));
  const attributeByCode = new Map(core.attributes.map((row) => [row.code, row]));
  const allCodes = new Set();
  for (const row of [...core.activities, ...core.attributes, ...core.units, ...core.choices]) {
    assert(!allCodes.has(row.code), `duplicate core vocab code ${row.code}`);
    allCodes.add(row.code);
  }
  for (const attribute of core.attributes.filter((row) => row.value_type === 'number')) {
    assert(attribute.quantity_kind, `${attribute.code} missing quantity_kind`);
    assert(attribute.basis, `${attribute.code} missing basis`);
    assert(unitByCode.has(attribute.default_unit_code), `${attribute.code} has unknown default unit ${attribute.default_unit_code}`);
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
  for (const unit of core.units) {
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
  }
  for (const choice of core.choices) {
    assert(attributeByCode.has(choice.parent_code), `${choice.code} has unknown parent ${choice.parent_code}`);
  }
}

function validateSource(source) {
  assert(source.categories.length === 7, 'Agroscope source must contain seven categories');
  const operations = source.categories.flatMap((category) => category.operations);
  const sourceSlots = operations.reduce((count, operation) => count + operation.devices.length, 0);
  assert(operations.length === 25, 'Agroscope source must contain 25 operations');
  assert(source.counts.device_slots === 128 && sourceSlots === 128,
    'Agroscope source must retain all 128 extracted device slots');
  assert(Object.keys(CATEGORY_ACTIVITY).length === 7, 'category mapping must contain exactly seven categories');
  for (const category of source.categories) {
    assert(CATEGORY_ACTIVITY[category.code], `unmapped Agroscope category ${category.code}`);
  }
  const sourceProducts = new Set(source.product_suggestions);
  for (const product of core.products) {
    assert(sourceProducts.has(product.name), `core product is not source-supported: ${product.name}`);
    assert(Object.keys(product.composition).length === 0,
      `source has no defensible composition for ${product.name}; composition must stay empty`);
  }
}

function findSourceDevice(source, operationCode, deviceCode) {
  for (const category of source.categories) {
    const operation = category.operations.find((candidate) => candidate.code === operationCode);
    if (!operation) continue;
    const device = operation.devices.find((candidate) => candidate.code === deviceCode);
    if (device) return { category, operation, device };
  }
  return null;
}

function validateRepresentativeBindings(source) {
  const checks = [
    ['primary_tillage', 'plough', 'cm', 'attr.amount_operation_depth', 'unit.cm_operation_depth'],
    ['sowing_main_crop', 'direct_drill', 'kg/ha', 'attr.amount_mass_area_product', 'unit.kg_per_ha_product'],
    ['sowing_main_crop', 'direct_drill', 'plants/ha', 'attr.amount_count_area', 'unit.plants_per_ha'],
    ['organic_fertilization', 'liquid_organic_broadcast', 'm3/ha', 'attr.amount_volume_area_product', 'unit.m3_per_ha_product'],
    ['organic_fertilization', 'liquid_organic_broadcast', 't/ha', 'attr.amount_mass_area_product', 'unit.t_per_ha_product'],
    ['mineral_fertilization', 'solid_broadcast', 'kg N/ha', 'attr.amount_nutrient_rate', 'unit.kg_n_per_ha_nutrient'],
    ['mineral_fertilization', 'solid_broadcast', 'kg P2O5/ha', 'attr.amount_nutrient_rate', 'unit.kg_p2o5_per_ha_nutrient'],
    ['other_fertilization', 'biofertilizer', 'l/ha', 'attr.amount_volume_area_product', 'unit.l_per_ha_product'],
    ['other_fertilization', 'biofertilizer', 'g/ha', 'attr.amount_mass_area_product', 'unit.g_per_ha_product'],
    ['watering', 'sprinkler_irrigation', 'm3/ha', 'attr.irrigation_volume_area', 'unit.m3_per_ha_water'],
  ];
  for (const [operationCode, deviceCode, sourceUnit, expectedAttribute, expectedUnit] of checks) {
    const found = findSourceDevice(source, operationCode, deviceCode);
    assert(found, `representative source device missing: ${operationCode}/${deviceCode}`);
    assert(found.device.units.includes(sourceUnit),
      `representative source unit missing: ${operationCode}/${deviceCode}/${sourceUnit}`);
    const [attributeCode, unitCode] = bindingFor(found.category.code, sourceUnit);
    assert(attributeCode === expectedAttribute && unitCode === expectedUnit,
      `representative binding drift: ${operationCode}/${deviceCode}/${sourceUnit}`);
  }
}

function buildAgroscope(source) {
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
            sourceCategory: category.code,
            units: device.units,
            descriptions: new Set(),
            sources: new Set(),
          });
        }
        const metadata = deviceMetadata.get(device.code);
        assert(stableStringify(metadata.units) === stableStringify(device.units),
          `device ${device.code} has inconsistent source unit sets`);
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
      when: { attribute_code: 'activity_code', equals: CATEGORY_ACTIVITY[category.code] },
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
      const [attributeCode, unitCode] = bindingFor(metadata.sourceCategory, sourceUnit);
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
        activity_codes: source.categories.map((category) => CATEGORY_ACTIVITY[category.code]),
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
  };
}

function buildRows(source) {
  validateCore();
  validateSource(source);
  validateRepresentativeBindings(source);
  const agroscope = buildAgroscope(source);
  const rows = [];

  for (const activity of core.activities) {
    rows.push(vocabRow({ ...activity, kind: 'activity' }));
  }
  let attributeSort = 100;
  for (const attribute of core.attributes) {
    rows.push(vocabRow({ ...attribute, kind: 'attribute', sort_order: attributeSort++ }));
  }
  let unitSort = 500;
  for (const sourceUnit of core.units) {
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
  for (const coreChoice of core.choices) {
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

  for (const template of core.templates) {
    rows.push({
      table: 'journal_templates',
      key: `${template.code}:${template.version}`,
      columns: ['code', 'version', 'labels_json', 'definition_json', 'active'],
      values: [template.code, template.version, JSON.stringify({ en: template.label }), JSON.stringify(template.definition), 1],
    });
  }
  for (const layout of [...core.layouts, agroscope.layout]) {
    rows.push({
      table: 'journal_layouts',
      key: `${layout.code}:${layout.version}`,
      columns: ['code', 'version', 'labels_json', 'definition_json', 'active'],
      values: [layout.code, layout.version, JSON.stringify({ en: layout.label }), JSON.stringify(layout.definition), 1],
    });
  }
  for (const product of core.products) {
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
      const [attributeCode, unitCode] = bindingFor(category.code, sourceUnit);
      assert(vocabCodes.has(attributeCode), `missing generated amount attribute ${attributeCode}`);
      assert(vocabCodes.has(unitCode), `missing generated unit ${unitCode}`);
    }
  }
  return rows;
}

function buildOutput(source) {
  const rows = buildRows(source);
  const hashInput = rows.map((row) => ({
    table: row.table,
    key: row.key,
    columns: row.columns,
    values: row.values,
  }));
  const catalogHash = sha256(stableStringify(hashInput));
  const sections = [];
  for (const table of ['journal_vocab', 'journal_templates', 'journal_layouts', 'journal_products']) {
    sections.push(`-- ${table}`);
    for (const row of rows.filter((candidate) => candidate.table === table)) {
      sections.push(insertOrIgnore(row.table, row.columns, row.values));
    }
    sections.push('');
  }
  sections.push('-- journal_catalog_state');
  sections.push(
    `INSERT OR REPLACE INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at) VALUES (1,${CATALOG_VERSION},${sqlValue(catalogHash)},${sqlValue(FIXED_TIMESTAMP)});`
  );
  const rowSql = sections.join('\n').trimEnd() + '\n';
  const migration = [
    '-- risk: data',
    '-- GENERATED by scripts/generate-journal-catalog.js; do not edit by hand.',
    '-- Source: SoilManageR management-data template v2.6 + scripts/journal-catalog-core.js.',
    `-- catalog-row-content-sha256: ${catalogHash}`,
    '',
    rowSql.trimEnd(),
    '',
  ].join('\n');
  const seedBlock = `${SEED_BEGIN}\n${rowSql}${SEED_END}\n`;
  return { catalogHash, migration, seedBlock };
}

function replaceSeedBlock(seed, seedBlock) {
  const start = seed.indexOf(SEED_BEGIN);
  const end = seed.indexOf(SEED_END);
  if (start === -1 && end === -1) {
    return seed.trimEnd() + '\n\n' + seedBlock;
  }
  if (start === -1 || end === -1 || end < start) {
    fail('seed contains an incomplete generated journal catalog marker block');
  }
  const after = end + SEED_END.length;
  return seed.slice(0, start) + seedBlock.trimEnd() + seed.slice(after);
}

function expectedManifestText(manifest, migration) {
  const next = { ...manifest, [MIGRATION_NAME]: sha256(migration) };
  const ordered = Object.fromEntries(Object.entries(next).sort(([left], [right]) => left.localeCompare(right)));
  return JSON.stringify(ordered, null, 2) + '\n';
}

function checkEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label} is stale; run node scripts/generate-journal-catalog.js`);
  }
}

function main(argv) {
  const check = argv.length === 1 && argv[0] === '--check';
  if (argv.length && !check) fail(`unsupported argument(s): ${argv.join(' ')}`);

  const source = JSON.parse(fs.readFileSync(SOURCE_PATH, 'utf8'));
  const { catalogHash, migration, seedBlock } = buildOutput(source);
  const currentSeed = fs.readFileSync(SEED_PATH, 'utf8');
  const expectedSeed = replaceSeedBlock(currentSeed, seedBlock);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const manifestText = expectedManifestText(manifest, migration);

  if (check) {
    checkEqual(fs.existsSync(MIGRATION_PATH) ? fs.readFileSync(MIGRATION_PATH, 'utf8') : '', migration, MIGRATION_NAME);
    checkEqual(currentSeed, expectedSeed, 'database/seed-blank.sql generated catalog block');
    checkEqual(fs.readFileSync(MANIFEST_PATH, 'utf8'), manifestText, 'CHECKSUMS.json journal catalog checksum');
    console.log(`generate-journal-catalog: OK (${catalogHash})`);
    return;
  }

  fs.writeFileSync(MIGRATION_PATH, migration);
  fs.writeFileSync(SEED_PATH, expectedSeed);
  fs.writeFileSync(MANIFEST_PATH, manifestText);
  console.log(`generate-journal-catalog: wrote ${MIGRATION_NAME}, seed block, and checksum (${catalogHash})`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`generate-journal-catalog: FAIL: ${error.message}`);
  process.exit(1);
}
