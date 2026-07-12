#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const seedPath = path.join(repoRoot, 'database', 'seed-blank.sql');
const migrationPath = path.join(
  repoRoot,
  'database',
  'migrations',
  'ordered',
  '0015__journal_catalog_v1.sql'
);
const sourceCatalog = require(path.join(
  repoRoot,
  'docs/superpowers/specs/agroscope-open-field/catalog.json'
));

const BUNDLED_DB_PATHS = [
  'conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db',
  'conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db',
  'conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db',
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db',
  'database/farming.db',
  'web/react-gui/farming.db',
].map((relativePath) => path.join(repoRoot, relativePath));

const ADAPT_SCHEME_URI = 'https://github.com/ADAPT/Standard';
const ADAPT_SOURCE_URI =
  'https://github.com/ADAPT/Standard/blob/1.0.0/adapt-data-type-definitions.json';
const EXPECTED_MAPPINGS = [
  ['fertilization', 'APPLICATION_FERTILIZING', 'exact'],
  ['harvest', 'HARVEST', 'exact'],
  ['irrigation', 'APPLICATION_IRRIGATION', 'exact'],
  ['plant_protection_application', 'APPLICATION_CROP_PROTECTION', 'exact'],
  ['planting_transplanting', 'APPLICATION_SOWING_AND_PLANTING', 'close'],
  ['seeding', 'APPLICATION_SOWING_AND_PLANTING', 'close'],
  ['tillage_soil_work', 'FIELD_PREPARATION_TILLAGE', 'exact'],
].map(([term_code, external_id, mapping_relation]) => ({
  term_code,
  scheme_uri: ADAPT_SCHEME_URI,
  scheme_version: '1.0.0',
  mapping_role: 'operation_type',
  external_id,
  external_parent_id: null,
  mapping_relation,
  source_uri: ADAPT_SOURCE_URI,
  active: 1,
}));

const NUTRIENT_UNIT_CODES = [
  'unit.kg_b_per_ha_nutrient',
  'unit.kg_ca_per_ha_nutrient',
  'unit.kg_cao_per_ha_nutrient',
  'unit.kg_k2o_per_ha_nutrient',
  'unit.kg_mg_per_ha_nutrient',
  'unit.kg_mn_per_ha_nutrient',
  'unit.kg_n_per_ha_nutrient',
  'unit.kg_na_per_ha_nutrient',
  'unit.kg_p2o5_per_ha_nutrient',
  'unit.kg_s_per_ha_nutrient',
];

const EXPECTED_LAYOUT_MINIMUMS = {
  open_field: [
    'attr.block_bed_row',
    'attr.treated_area',
    'attr.cover_type',
    'attr.denominator',
  ],
  greenhouse: [
    'attr.structure_compartment',
    'attr.root_zone_system',
    'attr.plant_area',
    'attr.wetted_area',
    'attr.drainage_volume',
    'attr.recirculation',
  ],
  lysimeter: [
    'attr.experimental_unit',
    'attr.replicate',
    'attr.treatment',
    'attr.surface_area',
    'attr.interval_minutes',
    'attr.water_input',
    'attr.rain_input',
    'attr.drainage_volume',
    'attr.mass_start',
    'attr.mass_end',
    'attr.tare_mass',
    'attr.mass_method',
  ],
};

const EXPECTED_ACTIVITIES = [
  'irrigation',
  'fertilization',
  'fertigation',
  'plant_protection_application',
  'weed_control_nonchemical',
  'seeding',
  'planting_transplanting',
  'pruning',
  'crop_care',
  'tillage_soil_work',
  'mowing',
  'harvest',
  'sampling',
  'general_observation',
  'pest_disease_observation',
  'equipment_maintenance',
];

const EXPECTED_CATEGORY_ACTIVITIES = {
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

function sqliteJson(dbPath, sql) {
  const output = execFileSync('sqlite3', ['-json', dbPath, sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  return JSON.parse(output || '[]');
}

function sqliteExec(dbPath, sql) {
  return execFileSync('sqlite3', ['-bail', dbPath], {
    input: sql,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function parseJsonColumn(row, column, context) {
  assert.equal(typeof row[column], 'string', `${context}.${column} must contain JSON text`);
  return JSON.parse(row[column]);
}

function catalogSnapshot(dbPath) {
  return {
    vocab: sqliteJson(dbPath, `
      SELECT code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,
             labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at
        FROM journal_vocab
       ORDER BY code;`),
    mappings: sqliteJson(dbPath, `
      SELECT term_code,scheme_uri,scheme_version,mapping_role,external_id,
             external_parent_id,mapping_relation,source_uri,active
        FROM journal_vocab_mappings
       ORDER BY term_code,scheme_uri,mapping_role,external_id;`),
    templates: sqliteJson(dbPath, `
      SELECT code,version,labels_json,definition_json,active
        FROM journal_templates
       ORDER BY code,version;`),
    layouts: sqliteJson(dbPath, `
      SELECT code,version,labels_json,definition_json,active
        FROM journal_layouts
       ORDER BY code,version;`),
    products: sqliteJson(dbPath, `
      SELECT product_uuid,scope,name,kind,composition_json,active,sync_version,created_at
        FROM journal_products
       ORDER BY product_uuid;`),
    state: sqliteJson(dbPath, `
      SELECT id,catalog_version,catalog_hash,updated_at
        FROM journal_catalog_state
       ORDER BY id;`),
    sequences: sqliteJson(dbPath, `
      SELECT name,seq
        FROM sqlite_sequence
       WHERE name='journal_vocab_mappings'
       ORDER BY name;`),
  };
}

function choiceCode(kind, code) {
  return `agroscope.${kind}.${code}`;
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
    devices.push({ code: 'mower', units: [] });
  }
  return devices;
}

function expectedBinding(categoryCode, unit) {
  if (unit === 'm3/ha') {
    return categoryCode === 'irrigation'
      ? ['attr.irrigation_volume_area', 'unit.m3_per_ha_water']
      : ['attr.amount_volume_area_product', 'unit.m3_per_ha_product'];
  }
  const binding = UNIT_BINDINGS[unit];
  assert.ok(binding, `test fixture must know how to bind Agroscope unit ${unit}`);
  return binding;
}

function rulesFor(dependencies, whenAttribute, restrictAttribute) {
  return dependencies.filter((rule) =>
    rule.when?.attribute_code === whenAttribute &&
    rule.restrict?.attribute_code === restrictAttribute
  );
}

function verifyAgroscopeDependencies(definition) {
  const dependencies = definition.option_dependencies;
  assert.ok(Array.isArray(dependencies), 'Agroscope option_dependencies must be an array');

  const sourceOperations = sourceCatalog.categories.flatMap((category) => category.operations);
  const sourceSlotCount = sourceOperations.reduce(
    (count, operation) => count + operation.devices.length,
    0
  );
  assert.equal(sourceCatalog.categories.length, 7, 'source catalog category count');
  assert.equal(sourceOperations.length, 25, 'source catalog operation count');
  assert.equal(sourceCatalog.counts.device_slots, 128, 'declared source device-slot count');
  assert.equal(sourceSlotCount, 128, 'contained source device-slot count');

  const categoryRules = rulesFor(dependencies, 'activity_code', 'attr.agroscope.operation');
  assert.equal(categoryRules.length, 7, 'one operation restriction per Agroscope source category');

  const operationRules = rulesFor(
    dependencies,
    'attr.agroscope.operation',
    'attr.agroscope.device'
  );
  assert.equal(operationRules.length, 25, 'one device restriction per Agroscope operation');

  let repairedSlotCount = 0;
  for (const category of sourceCatalog.categories) {
    const categoryRule = categoryRules.find((rule) => rule.source_category === category.code);
    assert.ok(categoryRule, `missing category dependency for ${category.code}`);
    assert.equal(categoryRule.when.equals, EXPECTED_CATEGORY_ACTIVITIES[category.code]);
    assert.deepEqual(
      categoryRule.restrict.choices,
      category.operations.map((operation) => choiceCode('operation', operation.code)),
      `operation choices for ${category.code}`
    );

    for (const operation of category.operations) {
      const devices = repairedDevices(operation);
      repairedSlotCount += devices.length;
      const operationCode = choiceCode('operation', operation.code);
      const operationRule = operationRules.find((rule) => rule.when.equals === operationCode);
      assert.ok(operationRule, `missing device dependency for ${operation.code}`);
      assert.deepEqual(
        operationRule.restrict.choices,
        devices.map((device) => choiceCode('device', device.code)),
        `device choices for ${operation.code}`
      );

      for (const device of devices) {
        const deviceCode = choiceCode('device', device.code);
        const actualByAttribute = new Map();
        for (const rule of dependencies.filter((candidate) =>
          candidate.when?.attribute_code === 'attr.agroscope.device' &&
          candidate.when.equals === deviceCode &&
          Array.isArray(candidate.restrict?.units)
        )) {
          assert.ok(
            !actualByAttribute.has(rule.restrict.attribute_code),
            `duplicate amount-family rule for ${device.code}/${rule.restrict.attribute_code}`
          );
          actualByAttribute.set(rule.restrict.attribute_code, rule.restrict.units);
        }

        const expectedByAttribute = new Map();
        for (const sourceUnit of device.units) {
          const [attributeCode, unitCode] = expectedBinding(category.code, sourceUnit);
          if (!expectedByAttribute.has(attributeCode)) expectedByAttribute.set(attributeCode, []);
          expectedByAttribute.get(attributeCode).push(unitCode);
        }
        assert.deepEqual(
          Object.fromEntries(actualByAttribute),
          Object.fromEntries(expectedByAttribute),
          `semantic amount-family unit restrictions for ${operation.code}/${device.code}`
        );
      }
    }
  }

  assert.equal(repairedSlotCount, 129, 'runtime cascade adds only cleaning_cut→mower');
  const cleaningRule = operationRules.find(
    (rule) => rule.when.equals === choiceCode('operation', 'cleaning_cut')
  );
  const harvestRule = operationRules.find(
    (rule) => rule.when.equals === choiceCode('operation', 'harvest_main_crop')
  );
  assert.deepEqual(cleaningRule.restrict.choices, [choiceCode('device', 'mower')]);
  assert.equal(
    harvestRule.restrict.choices.filter((code) => code === choiceCode('device', 'mower')).length,
    1,
    'harvest_main_crop must contain mower exactly once'
  );
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-schema-'));
const dbPath = path.join(tmpDir, 'farming.db');

try {
  execFileSync('sqlite3', ['-bail', dbPath], {
    input: fs.readFileSync(seedPath, 'utf8'),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const activities = sqliteJson(
    dbPath,
    "SELECT code FROM journal_vocab WHERE kind = 'activity' ORDER BY sort_order, code;"
  );
  assert.deepEqual(
    activities.map((row) => row.code),
    EXPECTED_ACTIVITIES,
    'seed must contain exactly the 16 canonical v1 activities'
  );

  const mappings = sqliteJson(
    dbPath,
    `SELECT term_code,scheme_uri,scheme_version,mapping_role,external_id,
            external_parent_id,mapping_relation,source_uri,active
       FROM journal_vocab_mappings
      ORDER BY term_code,scheme_uri,mapping_role,external_id;`
  );
  assert.deepEqual(
    mappings,
    EXPECTED_MAPPINGS,
    'seed must contain exactly the seven locally verified ADAPT 1.0.0 operation mappings'
  );

  const vocab = sqliteJson(
    dbPath,
    `SELECT code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,
            constraints_json
       FROM journal_vocab
      ORDER BY code;`
  );
  const vocabByCode = new Map(vocab.map((row) => [row.code, row]));

  const actuationReference = vocabByCode.get('attr.actuation_expectation_id');
  assert.ok(actuationReference, 'actuation expectation reference attribute must be seeded');
  assert.equal(actuationReference.value_type, 'text');
  assert.deepEqual(
    parseJsonColumn(actuationReference, 'constraints_json', actuationReference.code).reference,
    { table: 'valve_actuation_expectations', column: 'expectation_id' }
  );

  const productReference = vocabByCode.get('attr.product_uuid');
  assert.ok(productReference, 'registry-backed product reference attribute must be seeded');
  assert.equal(productReference.value_type, 'text');
  assert.deepEqual(
    parseJsonColumn(productReference, 'constraints_json', productReference.code).reference,
    { table: 'journal_products', column: 'product_uuid' }
  );
  const freeTextProduct = vocabByCode.get('attr.product');
  assert.equal(
    parseJsonColumn(freeTextProduct, 'constraints_json', freeTextProduct.code)
      .unregistered_compatibility,
    true,
    'attr.product must be explicitly marked as unregistered compatibility text'
  );

  const nutrientAttribute = vocabByCode.get('attr.amount_nutrient_rate');
  const nutrientConstraints = parseJsonColumn(
    nutrientAttribute,
    'constraints_json',
    nutrientAttribute.code
  );
  assert.equal(nutrientConstraints.requires_explicit_unit, true);
  assert.equal(nutrientConstraints.repeatable, true);
  assert.equal(nutrientConstraints.semantic_discriminator, 'unit_code');
  assert.equal(nutrientConstraints.allow_default_unit, false);
  assert.equal(
    nutrientAttribute.default_unit_code,
    null,
    'nutrient species must never silently default to nitrogen'
  );

  const nutrientDimensions = new Set();
  for (const unitCode of NUTRIENT_UNIT_CODES) {
    const unitRow = vocabByCode.get(unitCode);
    assert.ok(unitRow, `${unitCode} must be seeded`);
    const constraints = parseJsonColumn(unitRow, 'constraints_json', unitCode);
    nutrientDimensions.add(constraints.dimension);
    assert.deepEqual(
      constraints.to_canonical,
      { unit_code: unitCode, scale: 1, offset: 0 },
      `${unitCode} must be a self-canonical nutrient-species root`
    );
  }
  assert.equal(
    nutrientDimensions.size,
    NUTRIENT_UNIT_CODES.length,
    'each nutrient species must retain a distinct dimension'
  );

  const expectedConversions = {
    'unit.g_per_ha_product': {
      dimension: 'mass_product_per_area',
      basis: 'product',
      target: 'unit.kg_per_ha_product',
      scale: 0.001,
    },
    'unit.t_per_ha_product': {
      dimension: 'mass_product_per_area',
      basis: 'product',
      target: 'unit.kg_per_ha_product',
      scale: 1000,
    },
    'unit.m3_per_ha_product': {
      dimension: 'volume_product_per_area',
      basis: 'product',
      target: 'unit.l_per_ha_product',
      scale: 1000,
    },
    'unit.ha_area': {
      dimension: 'area',
      basis: 'land_area',
      target: 'unit.m2_area',
      scale: 10000,
    },
    'unit.hour_duration': {
      dimension: 'elapsed_time',
      basis: 'elapsed_time',
      target: 'unit.min_duration',
      scale: 60,
    },
    'unit.t_per_ha_fresh_product': {
      dimension: 'fresh_product_yield_per_area',
      basis: 'fresh_product',
      target: 'unit.kg_per_ha_fresh_product',
      scale: 1000,
    },
  };
  for (const [unitCode, expected] of Object.entries(expectedConversions)) {
    const row = vocabByCode.get(unitCode);
    assert.ok(row, `${unitCode} must be seeded`);
    const constraints = parseJsonColumn(row, 'constraints_json', unitCode);
    assert.equal(row.basis, expected.basis, `${unitCode} basis`);
    assert.equal(constraints.dimension, expected.dimension, `${unitCode} dimension`);
    assert.deepEqual(
      constraints.to_canonical,
      { unit_code: expected.target, scale: expected.scale, offset: 0 },
      `${unitCode} exact conversion`
    );
  }

  const harvestYield = vocabByCode.get('attr.harvest_yield_area');
  assert.ok(harvestYield, 'generic harvest yield-per-area attribute must be seeded');
  assert.equal(harvestYield.quantity_kind, 'yield_area');
  assert.equal(harvestYield.basis, 'fresh_product');
  assert.equal(harvestYield.default_unit_code, 'unit.kg_per_ha_fresh_product');
  const harvestArea = vocabByCode.get('attr.harvest_area');
  assert.ok(harvestArea, 'generic harvest area attribute must be seeded');
  assert.equal(harvestArea.quantity_kind, 'area');
  assert.equal(harvestArea.basis, 'land_area');

  const numericAttributes = sqliteJson(
    dbPath,
    `SELECT code, quantity_kind, basis, default_unit_code
       FROM journal_vocab
      WHERE kind = 'attribute' AND value_type = 'number'
      ORDER BY code;`
  );
  assert.ok(numericAttributes.length > 0, 'seed must contain numeric catalog attributes');
  for (const attribute of numericAttributes) {
    assert.ok(attribute.quantity_kind, `${attribute.code} must define quantity_kind`);
    assert.ok(attribute.basis, `${attribute.code} must define basis`);
    if (attribute.code !== 'attr.amount_nutrient_rate') {
      assert.ok(attribute.default_unit_code, `${attribute.code} must define default_unit_code`);
    }
  }

  const templates = sqliteJson(
    dbPath,
    'SELECT code,version,definition_json FROM journal_templates ORDER BY code,version;'
  );
  assert.deepEqual(
    templates.map(({ code, version }) => [code, version]),
    [
      ['farmer_quick', 1],
      ['full_record', 1],
      ['research_observation', 1],
    ],
    'seed must contain exactly three v1 templates'
  );
  const templateDefinitions = new Map(
    templates.map((template) => [template.code, JSON.parse(template.definition_json)])
  );
  const researchIdentity = templateDefinitions
    .get('research_observation')
    .sections.find((section) => section.code === 'identity');
  for (const field of [
    'campaign_uuid',
    'protocol_code',
    'protocol_version',
    'observation_unit_code',
  ]) {
    assert.ok(researchIdentity.fields.includes(field), `research identity must include ${field}`);
  }

  const fullRecord = templateDefinitions.get('full_record');
  assert.deepEqual(fullRecord.activity_requirements.fertilization, {
    required: ['attr.treated_area'],
    required_any: [
      ['attr.product_uuid', 'attr.product'],
      [
        'attr.amount_mass_area_product',
        'attr.amount_volume_area_product',
        'attr.amount_nutrient_rate',
      ],
    ],
  });
  assert.deepEqual(fullRecord.activity_requirements.fertigation, {
    required: ['attr.treated_area'],
    required_any: [
      ['attr.product_uuid', 'attr.product'],
      [
        'attr.amount_mass_area_product',
        'attr.amount_volume_area_product',
        'attr.amount_nutrient_rate',
      ],
    ],
  });
  assert.deepEqual(fullRecord.activity_requirements.plant_protection_application, {
    required: ['attr.treated_area'],
    required_any: [
      ['attr.product_uuid', 'attr.product'],
      [
        'attr.amount_mass_area_product',
        'attr.amount_volume_area_product',
        'attr.amount_biological_count_area',
      ],
    ],
  });
  assert.deepEqual(fullRecord.activity_requirements.seeding, {
    required: ['attr.crop', 'attr.treated_area'],
    required_any: [
      ['attr.amount_mass_area_product', 'attr.amount_count_area'],
    ],
  });
  assert.deepEqual(fullRecord.activity_requirements.planting_transplanting, {
    required: ['attr.crop', 'attr.treated_area'],
    required_any: [['attr.amount_count_area']],
  });
  assert.deepEqual(fullRecord.activity_requirements.harvest, {
    required: ['attr.crop', 'attr.harvest_area', 'attr.harvest_yield_area'],
    required_any: [],
  });
  assert.deepEqual(fullRecord.conditional_groups, [
    {
      code: 'irrigation_details',
      activity_codes: ['irrigation', 'fertigation'],
      required: [
        'attr.irrigation_amount_kind',
        'attr.measurement_source',
        'attr.denominator',
      ],
      required_any: [[
        'attr.irrigation_depth',
        'attr.irrigation_volume_area',
        'attr.per_plant_volume',
      ]],
      optional: ['attr.actuation_expectation_id'],
    },
  ]);

  const products = sqliteJson(
    dbPath,
    'SELECT name,composition_json FROM journal_products ORDER BY name;'
  );
  assert.equal(products.length, 10, 'seed must contain exactly ten core products');
  for (const product of products) {
    assert.deepEqual(JSON.parse(product.composition_json), {}, `${product.name} composition`);
  }

  const layouts = sqliteJson(
    dbPath,
    'SELECT code, version, definition_json FROM journal_layouts ORDER BY code, version;'
  );
  assert.deepEqual(
    layouts.map(({ code, version }) => [code, version]),
    [
      ['agroscope_open_field', 1],
      ['greenhouse', 1],
      ['lysimeter', 1],
      ['open_field', 1],
    ],
    'seed must contain exactly the four v1 layouts'
  );
  const parsedLayouts = new Map(
    layouts.map((layout) => [layout.code, JSON.parse(layout.definition_json)])
  );
  for (const [layoutCode, minimumFields] of Object.entries(EXPECTED_LAYOUT_MINIMUMS)) {
    assert.deepEqual(
      parsedLayouts.get(layoutCode).minimum_fields,
      minimumFields,
      `${layoutCode} minimum-field contract`
    );
  }
  verifyAgroscopeDependencies(parsedLayouts.get('agroscope_open_field'));

  const agroscopeDefinition = parsedLayouts.get('agroscope_open_field');
  const existingVocabCodes = new Set(vocab.map((row) => row.code));
  for (const field of agroscopeDefinition.fields) {
    assert.ok(existingVocabCodes.has(field), `Agroscope field ${field} must exist in vocab`);
  }
  for (const dependency of agroscopeDefinition.option_dependencies) {
    if (dependency.when.attribute_code !== 'activity_code') {
      assert.ok(
        existingVocabCodes.has(dependency.when.attribute_code),
        `dependency when attribute ${dependency.when.attribute_code} must exist in vocab`
      );
    }
    assert.ok(
      existingVocabCodes.has(dependency.restrict.attribute_code),
      `dependency restriction attribute ${dependency.restrict.attribute_code} must exist in vocab`
    );
    if (String(dependency.when.equals).startsWith('agroscope.')) {
      assert.ok(
        existingVocabCodes.has(dependency.when.equals),
        `dependency selected choice ${dependency.when.equals} must exist in vocab`
      );
    }
    for (const code of dependency.restrict.choices || []) {
      assert.ok(existingVocabCodes.has(code), `dependency choice ${code} must exist in vocab`);
    }
    for (const code of dependency.restrict.units || []) {
      assert.ok(existingVocabCodes.has(code), `dependency unit ${code} must exist in vocab`);
    }
  }

  const catalogState = sqliteJson(
    dbPath,
    'SELECT id, catalog_version, catalog_hash FROM journal_catalog_state WHERE id = 1;'
  );
  assert.equal(catalogState.length, 1, 'catalog state row id=1 must exist');
  assert.equal(catalogState[0].catalog_version, 1, 'catalog version must be 1');
  assert.match(catalogState[0].catalog_hash, /^[0-9a-f]{64}$/, 'catalog hash must be SHA-256');

  const seedText = fs.readFileSync(seedPath, 'utf8');
  const migrationText = fs.readFileSync(migrationPath, 'utf8');
  assert.equal(
    seedText.split('-- BEGIN GENERATED JOURNAL CATALOG V1').length - 1,
    1,
    'seed must contain exactly one generated catalog begin marker'
  );
  assert.equal(
    seedText.split('-- END GENERATED JOURNAL CATALOG V1').length - 1,
    1,
    'seed must contain exactly one generated catalog end marker'
  );

  const referenceSnapshot = catalogSnapshot(dbPath);
  for (const bundledDbPath of BUNDLED_DB_PATHS) {
    assert.deepEqual(
      catalogSnapshot(bundledDbPath),
      referenceSnapshot,
      `${path.relative(repoRoot, bundledDbPath)} catalog data must match the seed-built reference`
    );
  }

  const replayDbPath = path.join(tmpDir, 'replay.db');
  fs.copyFileSync(dbPath, replayDbPath);
  sqliteExec(replayDbPath, `BEGIN IMMEDIATE;\n${migrationText}\nCOMMIT;\n`);
  const afterFirstReplay = catalogSnapshot(replayDbPath);
  sqliteExec(replayDbPath, `BEGIN IMMEDIATE;\n${migrationText}\nCOMMIT;\n`);
  assert.deepEqual(
    catalogSnapshot(replayDbPath),
    afterFirstReplay,
    '0015 must be exactly idempotent on a matching installed catalog'
  );

  const conflictDbPath = path.join(tmpDir, 'conflict.db');
  fs.copyFileSync(dbPath, conflictDbPath);
  const sentinelHash = '0'.repeat(64);
  sqliteExec(conflictDbPath, `
    UPDATE journal_vocab
       SET default_unit_code = 'unit.t_per_ha_product'
     WHERE code = 'attr.amount_mass_area_product';
    DELETE FROM journal_vocab_mappings WHERE term_code = 'irrigation';
    UPDATE journal_catalog_state SET catalog_hash = '${sentinelHash}' WHERE id = 1;
  `);
  let conflictError = null;
  try {
    sqliteExec(conflictDbPath, `BEGIN IMMEDIATE;\n${migrationText}\nCOMMIT;\n`);
  } catch (error) {
    conflictError = error;
  }
  assert.ok(conflictError, '0015 must reject an immutable installed-row conflict');
  assert.match(
    String(conflictError.stderr || conflictError.message),
    /CHECK constraint failed/,
    'conflict rejection must come from the real SQLite catalog postcondition guard'
  );
  assert.equal(
    sqliteJson(
      conflictDbPath,
      "SELECT count(*) AS count FROM journal_vocab_mappings WHERE term_code='irrigation';"
    )[0].count,
    0,
    'guard failure must roll back an insert that preceded the conflict check'
  );
  assert.equal(
    sqliteJson(conflictDbPath, 'SELECT catalog_hash FROM journal_catalog_state WHERE id=1;')[0]
      .catalog_hash,
    sentinelHash,
    'guard failure must not stamp the intended catalog hash'
  );

  const versionTwoDbPath = path.join(tmpDir, 'version-two.db');
  fs.copyFileSync(dbPath, versionTwoDbPath);
  const versionTwoHash = '2'.repeat(64);
  const versionTwoTimestamp = '2026-07-12T01:00:00.000Z';
  sqliteExec(versionTwoDbPath, `
    DELETE FROM journal_vocab_mappings WHERE term_code = 'irrigation';
    UPDATE journal_catalog_state
       SET catalog_version=2,
           catalog_hash='${versionTwoHash}',
           updated_at='${versionTwoTimestamp}'
     WHERE id=1;
  `);
  sqliteExec(versionTwoDbPath, `BEGIN IMMEDIATE;\n${migrationText}\nCOMMIT;\n`);
  assert.deepEqual(
    sqliteJson(
      versionTwoDbPath,
      'SELECT catalog_version,catalog_hash,updated_at FROM journal_catalog_state WHERE id=1;'
    )[0],
    {
      catalog_version: 2,
      catalog_hash: versionTwoHash,
      updated_at: versionTwoTimestamp,
    },
    'replaying 0015 must not downgrade catalog state version 2'
  );
  assert.equal(
    sqliteJson(
      versionTwoDbPath,
      "SELECT count(*) AS count FROM journal_vocab_mappings WHERE term_code='irrigation';"
    )[0].count,
    0,
    'replaying 0015 must not mutate catalog data when a newer catalog is installed'
  );

  console.log('test-journal-schema: OK (catalog v1 semantics, guarded replay, seven-DB data parity)');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
