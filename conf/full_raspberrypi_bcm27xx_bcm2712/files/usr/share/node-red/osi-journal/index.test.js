'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { loadCatalog } = require('./catalog');
const { validateEntry } = require('./index');

const repoRoot = path.resolve(__dirname, '../../../../../../..');
const seedSql = fs.readFileSync(path.join(repoRoot, 'database/seed-blank.sql'), 'utf8');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-journal-test-'));
const databases = [];

test.after(() => {
  for (const db of databases) db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function createTestDb(name) {
  const db = new DatabaseSync(path.join(tempRoot, name + '.db'));
  db.exec(seedSql);
  databases.push(db);
  return db;
}

async function loadedFixture(name) {
  const catalog = await loadCatalog(createTestDb(name));
  return {
    catalog,
    farmerQuick: catalog.templates.get('farmer_quick').get(1),
    fullRecord: catalog.templates.get('full_record').get(1),
    openField: catalog.layouts.get('open_field').get(1),
  };
}

function validIrrigation(overrides) {
  return Object.assign({
    entry_uuid: '11111111-1111-4111-8111-111111111111',
    activity_code: 'irrigation',
    template_code: 'farmer_quick',
    layout_code: 'open_field',
    occurred_start_local: '2026-07-12T09:30:00',
    occurred_timezone: 'Europe/Zurich',
    values: [{
      attribute_code: 'attr.irrigation_depth',
      group_index: 0,
      value: 12,
      unit_code: 'unit.mm_water',
      value_status: 'observed',
    }],
    note: 'Morning irrigation',
  }, overrides || {});
}

test('loadCatalog reads the seeded catalog into code-indexed maps', async () => {
  const catalog = await loadCatalog(createTestDb('load'));

  assert.equal(catalog.version, 1);
  assert.match(catalog.hash, /^[a-f0-9]{64}$/);
  assert.equal(catalog.vocabByCode.get('irrigation').kind, 'activity');
  assert.equal(catalog.templates.get('farmer_quick').get(1).definition.max_primary_fields, 5);
  assert.ok(catalog.layouts.get('open_field').has(1));
  assert.equal(catalog.products.size, 10);
});

test('loadCatalog caches data queries until catalog state changes', async () => {
  const rawDb = createTestDb('cache');
  const counts = new Map();
  const db = {
    prepare(sql) {
      const table = (sql.match(/FROM\s+(\w+)/i) || [])[1] || 'other';
      counts.set(table, (counts.get(table) || 0) + 1);
      return rawDb.prepare(sql);
    },
  };

  const first = await loadCatalog(db);
  const second = await loadCatalog(db);
  assert.strictEqual(second, first);
  assert.equal(counts.get('journal_catalog_state'), 3);
  for (const table of ['journal_vocab', 'journal_templates', 'journal_layouts', 'journal_products']) {
    assert.equal(counts.get(table), 1, table);
  }

  rawDb.exec("UPDATE journal_catalog_state SET catalog_version=2, catalog_hash='" + 'f'.repeat(64) + "' WHERE id=1");
  const third = await loadCatalog(db);
  assert.notStrictEqual(third, first);
  assert.equal(third.version, 2);
  for (const table of ['journal_vocab', 'journal_templates', 'journal_layouts', 'journal_products']) {
    assert.equal(counts.get(table), 2, table);
  }
});

test('loadCatalog safely marks malformed catalog JSON without throwing', async () => {
  const db = createTestDb('malformed-catalog');
  db.exec("UPDATE journal_vocab SET constraints_json='{bad' WHERE code='attr.ph'");
  db.exec("UPDATE journal_catalog_state SET catalog_version=2, catalog_hash='" + 'e'.repeat(64) + "' WHERE id=1");

  const catalog = await loadCatalog(db);

  assert.deepEqual(catalog.vocabByCode.get('attr.ph').constraints, {});
  assert.deepEqual(catalog.vocabByCode.get('attr.ph').catalog_errors, ['constraints_json']);
});

test('loadCatalog supports the callback sqlite API used by Node-RED', async () => {
  const rawDb = createTestDb('callback-db');
  const callbackDb = {
    get(sql, _parameters, callback) {
      try { callback(null, rawDb.prepare(sql).get()); } catch (error) { callback(error); }
    },
    all(sql, _parameters, callback) {
      try { callback(null, rawDb.prepare(sql).all()); } catch (error) { callback(error); }
    },
  };

  const catalog = await loadCatalog(callbackDb);

  assert.equal(catalog.version, 1);
  assert.equal(catalog.vocabByCode.get('irrigation').kind, 'activity');
});

test('loadCatalog retries when catalog state changes during table reads', async () => {
  const rawDb = createTestDb('state-race');
  const counts = new Map();
  let changed = false;
  const db = {
    prepare(sql) {
      const table = (sql.match(/FROM\s+(\w+)/i) || [])[1] || 'other';
      counts.set(table, (counts.get(table) || 0) + 1);
      const statement = rawDb.prepare(sql);
      if (table === 'journal_products' && !changed) {
        changed = true;
        rawDb.exec(
          "UPDATE journal_catalog_state SET catalog_version=2, catalog_hash='" +
          'd'.repeat(64) + "' WHERE id=1"
        );
      }
      return statement;
    },
  };

  const catalog = await loadCatalog(db);

  assert.equal(catalog.version, 2);
  for (const table of ['journal_vocab', 'journal_templates', 'journal_layouts', 'journal_products']) {
    assert.equal(counts.get(table), 2, table);
  }
});

test('loadCatalog de-duplicates concurrent table reads for the same state', async () => {
  const rawDb = createTestDb('concurrent-load');
  const counts = new Map();
  const db = {
    get(sql, _parameters, callback) {
      const table = (sql.match(/FROM\s+(\w+)/i) || [])[1] || 'other';
      counts.set(table, (counts.get(table) || 0) + 1);
      setTimeout(() => callback(null, rawDb.prepare(sql).get()), 2);
    },
    all(sql, _parameters, callback) {
      const table = (sql.match(/FROM\s+(\w+)/i) || [])[1] || 'other';
      counts.set(table, (counts.get(table) || 0) + 1);
      setTimeout(() => callback(null, rawDb.prepare(sql).all()), 2);
    },
  };

  const [first, second] = await Promise.all([loadCatalog(db), loadCatalog(db)]);

  assert.strictEqual(second, first);
  for (const table of ['journal_vocab', 'journal_templates', 'journal_layouts', 'journal_products']) {
    assert.equal(counts.get(table), 1, table);
  }
});

test('loadCatalog fails visibly after bounded catalog churn', async () => {
  const rawDb = createTestDb('catalog-churn');
  let version = 1;
  let productReads = 0;
  const db = {
    prepare(sql) {
      const table = (sql.match(/FROM\s+(\w+)/i) || [])[1] || 'other';
      const statement = rawDb.prepare(sql);
      if (table === 'journal_products') {
        productReads += 1;
        version += 1;
        rawDb.exec(
          'UPDATE journal_catalog_state SET catalog_version=' + version +
          ", catalog_hash='" + String(version).padStart(64, '0') + "' WHERE id=1"
        );
      }
      return statement;
    },
  };

  await assert.rejects(loadCatalog(db), /changed during load/);
  assert.equal(productReads, 3);
});

test('validateEntry rejects an unknown activity code', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('unknown-activity');
  const result = validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({ activity_code: 'unknown_activity' })
  );

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) =>
    error.field === 'activity_code' && error.code === 'unknown_code'));
});

test('validateEntry rejects a choice outside its attribute vocabulary', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('invalid-choice');
  const input = validIrrigation({
    values: [{
      attribute_code: 'attr.denominator',
      group_index: 0,
      value: 'choice.denominator.not_real',
      value_status: 'observed',
    }],
  });

  const result = validateEntry(catalog, openField, farmerQuick, input);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) =>
    error.field === 'values[0].value' && error.code === 'invalid_choice'));
});

test('validateEntry enforces activity requirements from the template definition', async () => {
  const { catalog, fullRecord, openField } = await loadedFixture('template-required');
  const input = validIrrigation({
    activity_code: 'fertilization',
    template_code: 'full_record',
    values: [],
  });

  const result = validateEntry(catalog, openField, fullRecord, input);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) =>
    error.field === 'attr.treated_area' && error.code === 'required'));
  assert.ok(result.errors.some((error) =>
    error.field.includes('attr.product_uuid') && error.code === 'required'));
});

test('validateEntry enforces numeric min and max catalog constraints', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('numeric-range');
  const base = validIrrigation({
    activity_code: 'general_observation',
    values: [{
      attribute_code: 'attr.ph',
      group_index: 0,
      value: -0.1,
      unit_code: 'unit.ph',
      value_status: 'observed',
    }],
  });

  const below = validateEntry(catalog, openField, farmerQuick, base);
  const above = validateEntry(catalog, openField, farmerQuick, Object.assign({}, base, {
    values: [Object.assign({}, base.values[0], { value: 14.1 })],
  }));

  assert.equal(below.ok, false);
  assert.equal(above.ok, false);
  assert.ok(below.errors.some((error) => error.code === 'below_minimum'));
  assert.ok(above.errors.some((error) => error.code === 'above_maximum'));
});

test('validateEntry rejects notes longer than 4000 characters', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('note-limit');

  const result = validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({ note: 'n'.repeat(4001) })
  );

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) =>
    error.field === 'note' && error.code === 'limit_exceeded'));
});

test('validateEntry rejects more than 32 distinct value groups', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('group-limit');
  const values = Array.from({ length: 33 }, (_, groupIndex) => ({
    attribute_code: 'attr.irrigation_depth',
    group_index: groupIndex,
    value: 1,
    unit_code: 'unit.mm_water',
    value_status: 'observed',
  }));

  const result = validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({ values })
  );

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) =>
    error.field === 'values' && error.code === 'limit_exceeded'));
});

test('validateEntry normalizes a valid farmer_quick irrigation entry', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('valid-irrigation');
  const input = validIrrigation({
    values: [{
      attribute_code: 'attr.irrigation_depth',
      value: 12,
      unit_code: 'unit.mm_water',
    }],
  });

  const result = validateEntry(catalog, openField, farmerQuick, input);

  assert.equal(result.ok, true);
  assert.equal(result.normalized.activity_code, 'irrigation');
  assert.deepEqual(result.normalized.values, [{
    attribute_code: 'attr.irrigation_depth',
    group_index: 0,
    value: 12,
    unit_code: 'unit.mm_water',
    value_status: 'observed',
  }]);
});

test('validateEntry enforces the pinned layout and template compatibility', async () => {
  const { catalog, farmerQuick } = await loadedFixture('compatibility');
  const agroscope = catalog.layouts.get('agroscope_open_field').get(1);
  const input = validIrrigation({
    activity_code: 'equipment_maintenance',
    layout_code: 'agroscope_open_field',
    values: [],
  });

  const result = validateEntry(catalog, agroscope, farmerQuick, input);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) =>
    error.field === 'activity_code' && error.code === 'not_supported'));
  assert.ok(result.errors.some((error) =>
    error.field === 'template_code' && error.code === 'not_supported'));
});

test('validateEntry enforces catalog value types without coercion', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('value-types');
  catalog.vocabByCode.set('attr.test_date', {
    code: 'attr.test_date', kind: 'attribute', value_type: 'date', active: 1,
    constraints: {}, catalog_errors: [],
  });
  const cases = [
    ['attr.machine', 42],
    ['attr.recirculation', 'true'],
    ['attr.test_date', 20260712],
    ['attr.crop', 1],
  ];

  for (const [attributeCode, value] of cases) {
    const result = validateEntry(catalog, openField, farmerQuick, validIrrigation({
      activity_code: 'general_observation',
      values: [{ attribute_code: attributeCode, group_index: 0, value }],
    }));
    assert.equal(result.ok, false, attributeCode);
    assert.ok(result.errors.some((error) => error.code === 'invalid_type'), attributeCode);
  }
});

test('validateEntry enforces catalog maxlength and step constraints', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('other-constraints');
  const longText = validateEntry(catalog, openField, farmerQuick, validIrrigation({
    activity_code: 'general_observation',
    values: [{ attribute_code: 'attr.replicate', value: 'r'.repeat(81) }],
  }));
  const offStep = validateEntry(catalog, openField, farmerQuick, validIrrigation({
    activity_code: 'general_observation',
    values: [{ attribute_code: 'attr.agroscope.combination_group', value: 1.5 }],
  }));

  assert.equal(longText.ok, false);
  assert.ok(longText.errors.some((error) => error.code === 'limit_exceeded'));
  assert.equal(offStep.ok, false);
  assert.ok(offStep.errors.some((error) => error.code === 'step_mismatch'));
});

test('validateEntry rejects duplicate attributes inside one group', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('duplicate-value');
  const duplicate = {
    attribute_code: 'attr.irrigation_depth',
    group_index: 0,
    value: 12,
    unit_code: 'unit.mm_water',
  };

  const result = validateEntry(catalog, openField, farmerQuick, validIrrigation({
    values: [duplicate, Object.assign({}, duplicate, { value: 13 })],
  }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === 'duplicate_value'));
});

test('validateEntry evaluates deterministic required_if and visible_if predicates', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('predicates');
  const template = Object.assign({}, farmerQuick, {
    definition: {
      sections: [{
        code: 'conditional',
        fields: [
          {
            code: 'attr.target',
            required_if: { field: 'activity_code', op: 'eq', value: 'general_observation' },
          },
          {
            code: 'attr.method',
            visible_if: {
              field: 'attr.denominator',
              op: 'in',
              value: ['choice.denominator.row', 'choice.denominator.plant'],
            },
          },
        ],
      }],
    },
  });
  const input = validIrrigation({
    activity_code: 'general_observation',
    values: [
      { attribute_code: 'attr.denominator', value: 'choice.denominator.area' },
      { attribute_code: 'attr.method', value: 'hoe' },
    ],
  });

  const result = validateEntry(catalog, openField, template, input);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) =>
    error.field === 'attr.target' && error.code === 'required'));
  assert.ok(result.errors.some((error) =>
    error.field === 'attr.method' && error.code === 'not_visible'));
});

test('validateEntry enforces SEC-3 request, author, text, value, and context limits', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('sec-limits');
  catalog.vocabByCode.set('attr.test_unbounded_text', {
    code: 'attr.test_unbounded_text', kind: 'attribute', value_type: 'text', active: 1,
    constraints: {}, catalog_errors: [],
  });
  const validate = (overrides) => validateEntry(
    catalog, openField, farmerQuick, validIrrigation(overrides)
  );
  const author = validate({ author_label: 'a'.repeat(121) });
  const textBytes = validate({
    values: [{ attribute_code: 'attr.test_unbounded_text', value: 'é'.repeat(2049) }],
  });
  const valueCount = validate({ values: Array.from({ length: 129 }, () => ({
    attribute_code: 'attr.irrigation_depth', value: 1,
  })) });
  const context = validate({ context: { sample: 'c'.repeat(64 * 1024) } });
  const request = validate({ padding: 'p'.repeat(256 * 1024) });

  for (const [result, field] of [
    [author, 'author_label'],
    [textBytes, 'values[0].value'],
    [valueCount, 'values'],
    [context, 'context'],
    [request, 'entry'],
  ]) {
    assert.equal(result.ok, false, field);
    assert.ok(result.errors.some((error) =>
      error.field === field && error.code === 'limit_exceeded'), field);
  }
});

test('validateEntry returns structured errors for non-JSON input and invalid catalog JSON', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('bad-json');
  const circular = validIrrigation();
  circular.self = circular;
  const circularResult = validateEntry(catalog, openField, farmerQuick, circular);
  const contextResult = validateEntry(catalog, openField, farmerQuick, validIrrigation({
    context_json: '{not-json',
  }));
  const ph = catalog.vocabByCode.get('attr.ph');
  catalog.vocabByCode.set('attr.ph', Object.assign({}, ph, {
    constraints: {}, catalog_errors: ['constraints_json'],
  }));
  const catalogResult = validateEntry(catalog, openField, farmerQuick, validIrrigation({
    activity_code: 'general_observation',
    values: [{ attribute_code: 'attr.ph', value: 7, unit_code: 'unit.ph' }],
  }));

  assert.equal(circularResult.ok, false);
  assert.ok(circularResult.errors.some((error) => error.code === 'invalid_json'));
  assert.equal(contextResult.ok, false);
  assert.ok(contextResult.errors.some((error) => error.field === 'context_json'));
  assert.equal(catalogResult.ok, false);
  assert.ok(catalogResult.errors.some((error) => error.code === 'invalid_catalog'));
});

test('validateEntry measures the raw context_json payload against 64 KiB', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('raw-context-limit');
  const result = validateEntry(catalog, openField, farmerQuick, validIrrigation({
    context_json: ' '.repeat(64 * 1024) + '{}',
  }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) =>
    error.field === 'context_json' && error.code === 'limit_exceeded'));
});

test('template field requirements recognize present top-level entry fields', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('top-level-required');
  const template = Object.assign({}, farmerQuick, {
    definition: {
      sections: [{ code: 'notes', fields: [{ code: 'note', required: true }] }],
    },
  });

  const result = validateEntry(catalog, openField, template, validIrrigation({ note: 'present' }));

  assert.equal(result.ok, true);
});

test('validateEntry applies deterministic field rules supplied by a layout', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('layout-rules');
  const layout = Object.assign({}, openField, {
    definition: Object.assign({}, openField.definition, {
      fields: [{
        code: 'attr.equipment',
        required_if: { field: 'activity_code', op: 'eq', value: 'irrigation' },
      }],
    }),
  });

  const result = validateEntry(catalog, layout, farmerQuick, validIrrigation());

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) =>
    error.field === 'attr.equipment' && error.code === 'required'));
});

test('validateEntry enforces the seeded full_record irrigation conditional group', async () => {
  const { catalog, fullRecord, openField } = await loadedFixture('irrigation-group');
  const missing = validateEntry(catalog, openField, fullRecord, validIrrigation({
    template_code: 'full_record',
  }));
  const complete = validateEntry(catalog, openField, fullRecord, validIrrigation({
    template_code: 'full_record',
    values: [
      { attribute_code: 'attr.irrigation_amount_kind', value: 'choice.irrigation_amount.measured' },
      { attribute_code: 'attr.measurement_source', value: 'choice.measurement.manual' },
      { attribute_code: 'attr.denominator', value: 'choice.denominator.area' },
      { attribute_code: 'attr.irrigation_depth', value: 12, unit_code: 'unit.mm_water' },
    ],
  }));

  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((error) => error.field === 'attr.irrigation_amount_kind'));
  assert.equal(complete.ok, true);
});

test('validateEntry rejects unsupported predicate operators as catalog errors', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('bad-predicate');
  const template = Object.assign({}, farmerQuick, {
    definition: {
      sections: [{ fields: [{
        code: 'attr.target',
        required_if: { field: 'activity_code', op: 'exec', value: 'irrigation' },
      }] }],
    },
  });

  const result = validateEntry(catalog, openField, template, validIrrigation());

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === 'invalid_catalog'));
});

test('validateEntry rejects mismatched pinned template and layout versions', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('mismatched-versions');
  const result = validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({ template_version: 2, layout_version: 3 })
  );

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) =>
    error.field === 'layout_version' && error.code === 'definition_mismatch'));
  assert.ok(result.errors.some((error) =>
    error.field === 'template_version' && error.code === 'definition_mismatch'));
});

test('inactive definitions and terms fail create but exact correction rows remain valid', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('inactive-correction');
  const input = validIrrigation({
    template_version: 1,
    layout_version: 1,
    values: [
      {
        attribute_code: 'attr.irrigation_depth', group_index: 0, value: 12,
        unit_code: 'unit.mm_water', value_status: 'observed',
      },
      {
        attribute_code: 'attr.denominator', group_index: 0,
        value: 'choice.denominator.area', value_status: 'observed',
      },
    ],
  });
  for (const code of [
    'irrigation', 'attr.irrigation_depth', 'unit.mm_water', 'choice.denominator.area',
  ]) {
    catalog.vocabByCode.set(code, Object.assign({}, catalog.vocabByCode.get(code), { active: 0 }));
  }
  const inactiveTemplate = Object.assign({}, farmerQuick, { active: 0 });
  const inactiveLayout = Object.assign({}, openField, { active: 0 });
  const originalEntry = {
    activity_code: 'irrigation',
    template_code: 'farmer_quick',
    template_version: 1,
    layout_code: 'open_field',
    layout_version: 1,
    values: input.values.map((value) => ({
      attribute_code: value.attribute_code,
      group_index: value.group_index,
      value_num: typeof value.value === 'number' ? value.value : null,
      value_text: typeof value.value === 'string' ? value.value : null,
      value_status: value.value_status,
      unit_code: value.unit_code || null,
    })),
  };

  const create = validateEntry(catalog, inactiveLayout, inactiveTemplate, input);
  const definitionCreate = validateEntry(
    catalog,
    inactiveLayout,
    inactiveTemplate,
    validIrrigation({ activity_code: 'general_observation', values: [] })
  );
  const missingOriginal = validateEntry(
    catalog, inactiveLayout, inactiveTemplate, input, { mode: 'correction' }
  );
  const exactCorrection = validateEntry(
    catalog, inactiveLayout, inactiveTemplate, input,
    { mode: 'correction', originalEntry }
  );
  const changedCorrection = validateEntry(
    catalog,
    inactiveLayout,
    inactiveTemplate,
    Object.assign({}, input, {
      values: input.values.map((value, index) =>
        index === 0 ? Object.assign({}, value, { value: 13 }) : value),
    }),
    { mode: 'correction', originalEntry }
  );
  const changedPins = validateEntry(
    catalog,
    inactiveLayout,
    inactiveTemplate,
    Object.assign({}, input, { activity_code: 'general_observation' }),
    { mode: 'correction', originalEntry }
  );

  assert.equal(create.ok, false);
  assert.ok(create.errors.some((error) => error.code === 'inactive_term'));
  assert.equal(definitionCreate.ok, false);
  assert.ok(definitionCreate.errors.some((error) => error.code === 'inactive_definition'));
  assert.equal(missingOriginal.ok, false);
  assert.ok(missingOriginal.errors.some((error) => error.code === 'correction_context_required'));
  assert.equal(exactCorrection.ok, true);
  assert.equal(changedCorrection.ok, false);
  assert.ok(changedCorrection.errors.some((error) => error.code === 'inactive_value_changed'));
  assert.equal(changedPins.ok, false);
  assert.ok(changedPins.errors.some((error) => error.code === 'correction_pin_mismatch'));
});

test('inactive correction comparison decodes DB rows by attribute value type', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('inactive-db-types');
  catalog.vocabByCode.set('attr.test_date', {
    code: 'attr.test_date', kind: 'attribute', value_type: 'date', active: 0,
    constraints: {}, catalog_errors: [],
  });
  for (const code of ['attr.machine', 'attr.denominator', 'attr.recirculation']) {
    catalog.vocabByCode.set(code, Object.assign({}, catalog.vocabByCode.get(code), { active: 0 }));
  }
  const values = [
    { attribute_code: 'attr.machine', value: 'hoe' },
    { attribute_code: 'attr.denominator', value: 'choice.denominator.area' },
    { attribute_code: 'attr.test_date', value: '2026-07-12' },
    { attribute_code: 'attr.recirculation', value: true },
  ];
  const originalEntry = {
    activity_code: 'general_observation',
    template_code: 'farmer_quick', template_version: 1,
    layout_code: 'open_field', layout_version: 1,
    values: [
      { attribute_code: 'attr.machine', group_index: 0, value_text: 'hoe', value_status: 'observed' },
      {
        attribute_code: 'attr.denominator', group_index: 0,
        value_text: 'choice.denominator.area', value_status: 'observed',
      },
      {
        attribute_code: 'attr.test_date', group_index: 0,
        value_text: '2026-07-12', value_status: 'observed',
      },
      {
        attribute_code: 'attr.recirculation', group_index: 0,
        value_num: 1, value_status: 'observed',
      },
    ],
  };

  const result = validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({ activity_code: 'general_observation', values }),
    { mode: 'correction', originalEntry }
  );

  assert.equal(result.ok, true, JSON.stringify(result));
});

test('inactive correction preserves canonical and entered numeric audit fields bidirectionally', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('inactive-audit-fields');
  for (const code of ['attr.amount_mass_area_product', 'unit.t_per_ha_product']) {
    catalog.vocabByCode.set(code, Object.assign({}, catalog.vocabByCode.get(code), { active: 0 }));
  }
  const normalizedValue = {
    attribute_code: 'attr.amount_mass_area_product', group_index: 0,
    value: 1000, value_num: 1000, unit_code: 'unit.kg_per_ha_product',
    entered_value_num: 1, entered_unit_code: 'unit.t_per_ha_product',
    value_status: 'observed',
  };
  const originalEntry = {
    activity_code: 'general_observation',
    template_code: 'farmer_quick', template_version: 1,
    layout_code: 'open_field', layout_version: 1,
    values: [{
      attribute_code: 'attr.amount_mass_area_product', group_index: 0,
      value_num: 1000, value_text: null, unit_code: 'unit.kg_per_ha_product',
      entered_value_num: 1, entered_unit_code: 'unit.t_per_ha_product',
      value_status: 'observed',
    }],
  };
  const validateValues = (values) => validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({ activity_code: 'general_observation', values }),
    { mode: 'correction', originalEntry }
  );

  const exact = validateValues([normalizedValue]);
  const auditMutation = validateValues([
    Object.assign({}, normalizedValue, {
      entered_value_num: 999,
      entered_unit_code: 'unit.g_per_ha_product',
    }),
  ]);
  const omission = validateValues([]);

  assert.equal(exact.ok, true, JSON.stringify(exact));
  assert.equal(auditMutation.ok, false);
  assert.ok(auditMutation.errors.some((error) => error.code === 'inactive_value_changed'));
  assert.equal(omission.ok, false);
  assert.ok(omission.errors.some((error) => error.code === 'inactive_value_omitted'));

  catalog.vocabByCode.set(
    'attr.amount_mass_area_product',
    Object.assign({}, catalog.vocabByCode.get('attr.amount_mass_area_product'), { active: 1 })
  );
  const createWithRetiredEnteredUnit = validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({ activity_code: 'general_observation', values: [normalizedValue] })
  );
  assert.equal(createWithRetiredEnteredUnit.ok, false);
  assert.ok(createWithRetiredEnteredUnit.errors.some((error) =>
    error.field === 'values[0].entered_unit_code' && error.code === 'inactive_term'));
});

test('date attributes accept only real YYYY-MM-DD calendar dates', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('strict-dates');
  catalog.vocabByCode.set('attr.test_date', {
    code: 'attr.test_date', kind: 'attribute', value_type: 'date', active: 1,
    constraints: {}, catalog_errors: [],
  });
  const validateDate = (value) => validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({
      activity_code: 'general_observation',
      values: [{ attribute_code: 'attr.test_date', value }],
    })
  );

  assert.equal(validateDate('2024-02-29').ok, true);
  for (const value of ['2023-02-29', '2026-02-30', '03/04/2026', '2026-1-1', '2026-01-01T00:00:00Z']) {
    const result = validateDate(value);
    assert.equal(result.ok, false, value);
    assert.ok(result.errors.some((error) => error.code === 'invalid_date'), value);
  }
});

test('reference constraints resolve products and fail closed for external tables', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('references');
  const productUuid = catalog.products.keys().next().value;
  const validateValue = (attributeCode, value, validationContext) => validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({
      activity_code: 'general_observation',
      values: [{ attribute_code: attributeCode, value }],
    }),
    validationContext
  );

  assert.equal(validateValue('attr.product_uuid', productUuid).ok, true);
  const missingProduct = validateValue('attr.product_uuid', 'missing-product');
  assert.equal(missingProduct.ok, false);
  assert.ok(missingProduct.errors.some((error) => error.code === 'invalid_reference'));

  const unresolvedActuation = validateValue('attr.actuation_expectation_id', 'expectation-1');
  assert.equal(unresolvedActuation.ok, false);
  assert.ok(unresolvedActuation.errors.some((error) => error.code === 'reference_unresolved'));

  const mapResolved = validateValue(
    'attr.actuation_expectation_id',
    'expectation-1',
    {
      referenceValues: new Map([
        ['valve_actuation_expectations.expectation_id', new Set(['expectation-1'])],
      ]),
    }
  );
  const objectResolved = validateValue(
    'attr.actuation_expectation_id',
    'expectation-2',
    {
      referenceValues: {
        'valve_actuation_expectations.expectation_id': ['expectation-2'],
      },
    }
  );
  assert.equal(mapResolved.ok, true);
  assert.equal(objectResolved.ok, true);

  const product = catalog.products.get(productUuid);
  catalog.products.set(productUuid, Object.assign({}, product, { active: 0 }));
  assert.equal(validateValue('attr.product_uuid', productUuid).ok, false);
});

test('correction preserves retired product and external reference rows exactly', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('retired-references');
  const productUuids = Array.from(catalog.products.keys());
  const retiredProductUuid = productUuids[0];
  const replacementProductUuid = productUuids[1];
  catalog.products.set(
    retiredProductUuid,
    Object.assign({}, catalog.products.get(retiredProductUuid), {
      active: 0,
      deleted_at: '2026-07-12T12:00:00.000Z',
    })
  );
  const baseOriginal = {
    activity_code: 'general_observation',
    template_code: 'farmer_quick', template_version: 1,
    layout_code: 'open_field', layout_version: 1,
  };
  const validateCorrection = (originalEntry, values, referenceValues) => validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({ activity_code: 'general_observation', values }),
    { mode: 'correction', originalEntry, referenceValues }
  );
  const productOriginal = Object.assign({}, baseOriginal, {
    values: [{
      attribute_code: 'attr.product_uuid', group_index: 0,
      value_text: retiredProductUuid, value_status: 'observed',
    }],
  });
  const productValue = {
    attribute_code: 'attr.product_uuid', group_index: 0,
    value: retiredProductUuid, value_status: 'observed',
  };

  const exactProduct = validateCorrection(productOriginal, [productValue]);
  const omittedProduct = validateCorrection(productOriginal, []);
  const changedProduct = validateCorrection(productOriginal, [
    Object.assign({}, productValue, { value: replacementProductUuid }),
  ]);

  assert.equal(exactProduct.ok, true, JSON.stringify(exactProduct));
  assert.equal(omittedProduct.ok, false);
  assert.ok(omittedProduct.errors.some((error) => error.code === 'inactive_value_omitted'));
  assert.equal(changedProduct.ok, false);

  const referenceKey = 'valve_actuation_expectations.expectation_id';
  const referenceOriginal = Object.assign({}, baseOriginal, {
    values: [{
      attribute_code: 'attr.actuation_expectation_id', group_index: 0,
      value_text: 'retired-expectation', value_status: 'observed',
    }],
  });
  const referenceValue = {
    attribute_code: 'attr.actuation_expectation_id', group_index: 0,
    value: 'retired-expectation', value_status: 'observed',
  };
  const emptyReferenceSet = new Map([[referenceKey, new Set()]]);

  const exactReference = validateCorrection(
    referenceOriginal,
    [referenceValue],
    emptyReferenceSet
  );
  const omittedReference = validateCorrection(referenceOriginal, [], emptyReferenceSet);
  const changedReference = validateCorrection(
    referenceOriginal,
    [Object.assign({}, referenceValue, { value: 'new-dangling-expectation' })],
    emptyReferenceSet
  );

  assert.equal(exactReference.ok, true, JSON.stringify(exactReference));
  assert.equal(omittedReference.ok, false);
  assert.ok(omittedReference.errors.some((error) => error.code === 'inactive_value_omitted'));
  assert.equal(changedReference.ok, false);
});

test('required_any families pair semantically present product and dose in each repeat group', async () => {
  const { catalog, fullRecord, openField } = await loadedFixture('required-groups');
  const treatedArea = {
    attribute_code: 'attr.treated_area', group_index: 0, value: 100,
    unit_code: 'unit.m2_area',
  };
  const product = { attribute_code: 'attr.product', group_index: 0, value: 'NPK 15-15-15' };
  const dose = {
    attribute_code: 'attr.amount_mass_area_product', group_index: 0, value: 25,
    unit_code: 'unit.kg_per_ha_product',
  };
  const validateValues = (values) => validateEntry(
    catalog,
    openField,
    fullRecord,
    validIrrigation({
      activity_code: 'fertilization', template_code: 'full_record', values,
    })
  );

  const paired = validateValues([treatedArea, product, dose]);
  const crossGroup = validateValues([
    treatedArea,
    product,
    Object.assign({}, dose, { group_index: 1 }),
  ]);
  const blankProduct = validateValues([
    treatedArea,
    Object.assign({}, product, { value: '   ' }),
    dose,
  ]);
  const nonObservedProduct = validateValues([
    treatedArea,
    { attribute_code: 'attr.product', group_index: 0, value_status: 'not_observed' },
    dose,
  ]);

  assert.equal(paired.ok, true);
  assert.equal(crossGroup.ok, false);
  assert.ok(crossGroup.errors.some((error) => error.code === 'required_in_group'));
  assert.equal(blankProduct.ok, false);
  assert.equal(nonObservedProduct.ok, false);
});

test('malformed nested definitions and unknown rule references fail without throwing', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('malformed-definitions');
  const templateCases = [
    { sections: {} },
    { sections: [{ fields: {} }] },
    { activity_requirements: [] },
    { activity_requirements: { irrigation: { required: {}, required_any: [] } } },
    { activity_requirements: { irrigation: { required: [], required_any: ['attr.product'] } } },
    { conditional_groups: {} },
    { conditional_groups: [{ activity_codes: {}, required: [], required_any: [] }] },
    { sections: [{ fields: [{ code: 'attr.typo', required: true }] }] },
    { sections: [{ fields: [{
      code: 'attr.target',
      required_if: { field: 'attr.typo', op: 'eq', value: 'x' },
    }] }] },
  ];
  const layoutCases = [
    Object.assign({}, openField.definition, { supported_templates: {} }),
    Object.assign({}, openField.definition, { activity_codes: {} }),
    Object.assign({}, openField.definition, { fields: {} }),
  ];

  for (const definition of templateCases) {
    let result;
    assert.doesNotThrow(() => {
      result = validateEntry(
        catalog,
        openField,
        Object.assign({}, farmerQuick, { definition }),
        validIrrigation()
      );
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.code === 'invalid_catalog'));
  }
  for (const definition of layoutCases) {
    let result;
    assert.doesNotThrow(() => {
      result = validateEntry(
        catalog,
        Object.assign({}, openField, { definition }),
        farmerQuick,
        validIrrigation()
      );
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.code === 'invalid_catalog'));
  }
});

test('definition preflight rejects unknown predicate values in finite code domains', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('predicate-code-domains');
  const predicates = [
    { field: 'attr.denominator', op: 'eq', value: 'choice.denominator.typo' },
    {
      field: 'attr.denominator', op: 'in',
      value: ['choice.denominator.area', 'choice.denominator.typo'],
    },
    { field: 'activity_code', op: 'eq', value: 'irrigtion_typo' },
    { field: 'template_code', op: 'eq', value: 'farmer_quik' },
    { field: 'layout_code', op: 'eq', value: 'open_feld' },
  ];

  for (const predicate of predicates) {
    const template = Object.assign({}, farmerQuick, {
      definition: {
        sections: [{
          fields: [{ code: 'attr.target', required_if: predicate }],
        }],
      },
    });
    const result = validateEntry(catalog, openField, template, validIrrigation());
    assert.equal(result.ok, false, JSON.stringify(predicate));
    assert.ok(
      result.errors.some((error) => error.code === 'invalid_catalog'),
      JSON.stringify(predicate)
    );
  }
});

test('definition preflight type-checks scalar predicate domains and leaves text open', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('predicate-scalar-domains');
  catalog.vocabByCode.set('attr.test_date', {
    code: 'attr.test_date', kind: 'attribute', value_type: 'date', active: 1,
    constraints: {}, catalog_errors: [],
  });
  const resultFor = (predicate) => validateEntry(
    catalog,
    openField,
    Object.assign({}, farmerQuick, {
      definition: {
        sections: [{ fields: [{ code: 'attr.target', required_if: predicate }] }],
      },
    }),
    validIrrigation()
  );
  const invalidPredicates = [
    { field: 'attr.recirculation', op: 'eq', value: 'true' },
    { field: 'attr.ph', op: 'eq', value: '7' },
    { field: 'attr.ph', op: 'in', value: [7, '8'] },
    { field: 'attr.test_date', op: 'eq', value: 20260712 },
    { field: 'attr.test_date', op: 'in', value: ['2024-02-29', '2023-02-29'] },
    { field: 'attr.machine', op: 'eq', value: 42 },
  ];

  for (const predicate of invalidPredicates) {
    const result = resultFor(predicate);
    assert.equal(result.ok, false, JSON.stringify(predicate));
    assert.ok(
      result.errors.some((error) => error.code === 'invalid_catalog'),
      JSON.stringify(predicate)
    );
  }

  for (const predicate of [
    { field: 'attr.recirculation', op: 'eq', value: true },
    { field: 'attr.ph', op: 'eq', value: 7 },
    { field: 'attr.test_date', op: 'eq', value: '2024-02-29' },
    { field: 'attr.machine', op: 'eq', value: 'farmer-defined mower' },
  ]) {
    assert.equal(resultFor(predicate).ok, true, JSON.stringify(predicate));
  }
});
