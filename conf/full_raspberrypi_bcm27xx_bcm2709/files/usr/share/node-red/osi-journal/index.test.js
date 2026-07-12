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
  assert.equal(counts.get('journal_catalog_state'), 2);
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
