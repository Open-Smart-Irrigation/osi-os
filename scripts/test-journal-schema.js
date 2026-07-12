#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const seedPath = path.join(repoRoot, 'database', 'seed-blank.sql');
const sourceCatalog = require(path.join(
  repoRoot,
  'docs/superpowers/specs/agroscope-open-field/catalog.json'
));

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
    assert.ok(attribute.default_unit_code, `${attribute.code} must define default_unit_code`);
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
  verifyAgroscopeDependencies(parsedLayouts.get('agroscope_open_field'));

  const catalogState = sqliteJson(
    dbPath,
    'SELECT id, catalog_version, catalog_hash FROM journal_catalog_state WHERE id = 1;'
  );
  assert.equal(catalogState.length, 1, 'catalog state row id=1 must exist');
  assert.equal(catalogState[0].catalog_version, 1, 'catalog version must be 1');
  assert.match(catalogState[0].catalog_hash, /^[0-9a-f]{64}$/, 'catalog hash must be SHA-256');

  console.log('test-journal-schema: OK (catalog v1, 16 activities, 4 layouts, repaired Agroscope cascade)');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
