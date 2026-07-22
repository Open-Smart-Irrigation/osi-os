#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const seedPath = path.join(repoRoot, 'database', 'seed-blank.sql');
const fieldJournalMigrationPath = path.join(
  repoRoot,
  'database',
  'migrations',
  'ordered',
  '0018__field_journal.sql'
);
const migrationPath = path.join(
  repoRoot,
  'database',
  'migrations',
  'ordered',
  '0019__journal_catalog_v1.sql'
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

// v1 (frozen) minimum_fields, before Slice BC's static/reading split.
const EXPECTED_LAYOUT_MINIMUMS_V1 = {
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

// v3 (Slice BC / R1): minimum_fields is reduced to just the plot-static
// context fields; the removed measurement readings move to `reading_fields`
// (consumed only by the `sampling` Quick activity). open_field originally
// kept attr.treated_area in minimum_fields (full_record/research parity)
// even though it is excluded from static_context_fields.
//
// NOTE: despite the "V3" name, these values assert the currently-served
// (latest) version per code, resolved by `parsedLayouts` below — greenhouse
// and lysimeter are still at v3, but open_field's current version is now v8
// (treated-area-optional plan, 2026-07-22): attr.treated_area is dropped
// from minimum_fields there (paired with full_record@8 dropping it from
// activity_requirements), so it no longer force-requires the field for any
// activity. static_context_fields/reading_fields are unchanged from v3.
const EXPECTED_LAYOUT_MINIMUMS_V3 = {
  open_field: ['attr.block_bed_row', 'attr.cover_type', 'attr.denominator'],
  greenhouse: ['attr.structure_compartment', 'attr.root_zone_system', 'attr.plant_area'],
  lysimeter: ['attr.experimental_unit', 'attr.replicate', 'attr.treatment', 'attr.surface_area'],
};

const EXPECTED_LAYOUT_STATIC_CONTEXT_V3 = {
  open_field: ['attr.block_bed_row', 'attr.cover_type', 'attr.denominator'],
  greenhouse: EXPECTED_LAYOUT_MINIMUMS_V3.greenhouse,
  lysimeter: EXPECTED_LAYOUT_MINIMUMS_V3.lysimeter,
};

const EXPECTED_LAYOUT_READING_FIELDS_V3 = {
  open_field: [],
  greenhouse: ['attr.wetted_area', 'attr.drainage_volume', 'attr.recirculation'],
  lysimeter: [
    'attr.interval_minutes', 'attr.water_input', 'attr.rain_input', 'attr.drainage_volume',
    'attr.mass_start', 'attr.mass_end', 'attr.tare_mass', 'attr.mass_method',
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

function plotSettingsForeignKeys(dbPath) {
  return sqliteJson(dbPath, 'PRAGMA foreign_key_list(journal_plot_settings);').map((row) => ({
    id: row.id,
    seq: row.seq,
    table: row.table,
    from: row.from,
    to: row.to,
    on_update: row.on_update,
    on_delete: row.on_delete,
    match: row.match,
  }));
}

const EXPECTED_PLOT_SETTINGS_FOREIGN_KEYS = [{
  id: 0,
  seq: 0,
  table: 'journal_plots',
  from: 'plot_uuid',
  to: 'plot_uuid',
  on_update: 'NO ACTION',
  on_delete: 'CASCADE',
  match: 'NONE',
}];

const EXPECTED_JOURNAL_ENTRY_FOREIGN_KEYS = [
  {
    id: 0,
    seq: 0,
    table: 'journal_vocab',
    from: 'activity_code',
    to: 'code',
    on_update: 'NO ACTION',
    on_delete: 'NO ACTION',
    match: 'NONE',
  },
  {
    id: 1,
    seq: 0,
    table: 'journal_plots',
    from: 'plot_uuid',
    to: 'plot_uuid',
    on_update: 'NO ACTION',
    on_delete: 'NO ACTION',
    match: 'NONE',
  },
  {
    id: 2,
    seq: 0,
    table: 'users',
    from: 'user_id',
    to: 'id',
    on_update: 'NO ACTION',
    on_delete: 'CASCADE',
    match: 'NONE',
  },
];

const EXPECTED_JOURNAL_ENTRY_VALUE_FOREIGN_KEYS = [
  {
    id: 0,
    seq: 0,
    table: 'journal_vocab',
    from: 'attribute_code',
    to: 'code',
    on_update: 'NO ACTION',
    on_delete: 'NO ACTION',
    match: 'NONE',
  },
  {
    id: 1,
    seq: 0,
    table: 'journal_entries',
    from: 'entry_uuid',
    to: 'entry_uuid',
    on_update: 'NO ACTION',
    on_delete: 'CASCADE',
    match: 'NONE',
  },
];

const EXPECTED_JOURNAL_ATTACHMENT_FOREIGN_KEYS = [{
  id: 0,
  seq: 0,
  table: 'journal_entries',
  from: 'entry_uuid',
  to: 'entry_uuid',
  on_update: 'NO ACTION',
  on_delete: 'CASCADE',
  match: 'NONE',
}];

function foreignKeys(dbPath, table) {
  return sqliteJson(dbPath, `PRAGMA foreign_key_list(${table});`).map((row) => ({
    id: row.id,
    seq: row.seq,
    table: row.table,
    from: row.from,
    to: row.to,
    on_update: row.on_update,
    on_delete: row.on_delete,
    match: row.match,
  }));
}

function journalEntryInsert(entryUuid, plotUuid, activityCode) {
  return `
    INSERT INTO journal_entries(
      entry_uuid,owner_user_uuid,user_id,author_principal_uuid,plot_uuid,
      activity_code,template_code,template_version,layout_code,layout_version,
      catalog_version,occurred_start,occurred_timezone,occurred_utc_offset_minutes,
      recorded_at,origin,status,sync_version,created_at,updated_at
    ) VALUES (
      '${entryUuid}','schema-owner',2147483000,'schema-author','${plotUuid}',
      '${activityCode}','schema-template',1,'open_field',1,
      1,'2026-07-15T00:00:00.000Z','UTC',0,
      '2026-07-15T00:00:01.000Z','edge-ui','draft',0,
      '2026-07-15T00:00:01.000Z','2026-07-15T00:00:01.000Z'
    );
  `;
}

function foreignKeyRejected(dbPath, sql) {
  try {
    sqliteExec(dbPath, `PRAGMA foreign_keys=ON;\n${sql}`);
    return false;
  } catch (error) {
    return /FOREIGN KEY constraint failed/.test(String(error.stderr || error.message));
  }
}

function journalSemanticForeignKeyFacts(dbPath) {
  sqliteExec(dbPath, `
    PRAGMA foreign_keys=ON;
    INSERT INTO users(id,username,password_hash,created_at)
      VALUES (2147483000,'schema-semantic-fk-user','schema-hash','2026-07-15T00:00:00.000Z');
    INSERT INTO journal_plots(plot_uuid,plot_code)
      VALUES ('schema-semantic-fk-plot','schema-semantic-fk-plot');
    INSERT INTO journal_vocab(code,kind,value_type)
      VALUES ('schema.semantic.activity','activity',NULL);
    INSERT INTO journal_vocab(code,kind,value_type)
      VALUES ('schema.semantic.attribute','attribute','text');
  `);

  const orphanPlotRejected = foreignKeyRejected(
    dbPath,
    journalEntryInsert(
      'schema-semantic-fk-orphan-plot',
      'schema-semantic-fk-missing-plot',
      'schema.semantic.activity'
    )
  );
  const orphanActivityRejected = foreignKeyRejected(
    dbPath,
    journalEntryInsert(
      'schema-semantic-fk-orphan-activity',
      'schema-semantic-fk-plot',
      'schema.semantic.missing-activity'
    )
  );

  sqliteExec(
    dbPath,
    `PRAGMA foreign_keys=ON;\n${journalEntryInsert(
      'schema-semantic-fk-valid-entry',
      'schema-semantic-fk-plot',
      'schema.semantic.activity'
    )}
    INSERT INTO journal_entry_values(entry_uuid,attribute_code,value_text)
      VALUES ('schema-semantic-fk-valid-entry','schema.semantic.attribute','valid');
    `
  );

  const orphanAttributeRejected = foreignKeyRejected(
    dbPath,
    `INSERT INTO journal_entry_values(entry_uuid,attribute_code,value_text)
       VALUES ('schema-semantic-fk-valid-entry','schema.semantic.missing-attribute','orphan');`
  );
  const validEntryCount = sqliteJson(
    dbPath,
    "SELECT count(*) AS count FROM journal_entries WHERE entry_uuid='schema-semantic-fk-valid-entry';"
  )[0].count;
  const validValueCount = sqliteJson(
    dbPath,
    "SELECT count(*) AS count FROM journal_entry_values WHERE entry_uuid='schema-semantic-fk-valid-entry';"
  )[0].count;
  sqliteExec(dbPath, `
    PRAGMA foreign_keys=ON;
    DELETE FROM journal_entries WHERE entry_uuid='schema-semantic-fk-valid-entry';
  `);
  const cascadeRemaining = sqliteJson(
    dbPath,
    "SELECT count(*) AS count FROM journal_entry_values WHERE entry_uuid='schema-semantic-fk-valid-entry';"
  )[0].count;

  sqliteExec(dbPath, `
    PRAGMA foreign_keys=ON;
    DELETE FROM users WHERE id=2147483000;
    DELETE FROM journal_vocab
      WHERE code IN ('schema.semantic.activity','schema.semantic.attribute');
    DELETE FROM journal_plots WHERE plot_uuid='schema-semantic-fk-plot';
  `);

  return {
    entryForeignKeys: foreignKeys(dbPath, 'journal_entries'),
    valueForeignKeys: foreignKeys(dbPath, 'journal_entry_values'),
    orphanPlotRejected,
    orphanActivityRejected,
    orphanAttributeRejected,
    validEntryCount,
    validValueCount,
    cascadeRemaining,
  };
}

function assertJournalSemanticForeignKeyBehavior(dbPath, context) {
  assert.deepEqual(
    journalSemanticForeignKeyFacts(dbPath),
    {
      entryForeignKeys: EXPECTED_JOURNAL_ENTRY_FOREIGN_KEYS,
      valueForeignKeys: EXPECTED_JOURNAL_ENTRY_VALUE_FOREIGN_KEYS,
      orphanPlotRejected: true,
      orphanActivityRejected: true,
      orphanAttributeRejected: true,
      validEntryCount: 1,
      validValueCount: 1,
      cascadeRemaining: 0,
    },
    `${context} must enforce journal plot/activity/attribute references and entry-value cascade`
  );
}

function journalAttachmentForeignKeyFacts(dbPath) {
  const entryUuid = 'schema-attachment-fk-valid-entry';
  const attachmentUuid = 'schema-attachment-fk-valid-attachment';

  sqliteExec(dbPath, `
    PRAGMA foreign_keys=ON;
    INSERT INTO users(id,username,password_hash,created_at)
      VALUES (2147483000,'schema-attachment-fk-user','schema-hash','2026-07-15T00:00:00.000Z');
    INSERT INTO journal_plots(plot_uuid,plot_code)
      VALUES ('schema-attachment-fk-plot','schema-attachment-fk-plot');
    INSERT INTO journal_vocab(code,kind,value_type)
      VALUES ('schema.attachment.activity','activity',NULL);
    ${journalEntryInsert(
      entryUuid,
      'schema-attachment-fk-plot',
      'schema.attachment.activity'
    )}
  `);

  let validInsertSucceeded = false;
  try {
    sqliteExec(dbPath, `
      PRAGMA foreign_keys=ON;
      INSERT INTO journal_attachments(attachment_uuid,entry_uuid,kind)
        VALUES ('${attachmentUuid}','${entryUuid}','photo');
    `);
    validInsertSucceeded = true;
  } catch (_) {
    validInsertSucceeded = false;
  }

  const validAttachmentCount = sqliteJson(
    dbPath,
    `SELECT count(*) AS count FROM journal_attachments
      WHERE attachment_uuid='${attachmentUuid}';`
  )[0].count;
  sqliteExec(dbPath, `
    PRAGMA foreign_keys=ON;
    DELETE FROM journal_entries WHERE entry_uuid='${entryUuid}';
  `);
  const cascadeRemaining = sqliteJson(
    dbPath,
    `SELECT count(*) AS count FROM journal_attachments
      WHERE attachment_uuid='${attachmentUuid}';`
  )[0].count;

  sqliteExec(dbPath, `
    PRAGMA foreign_keys=ON;
    DELETE FROM users WHERE id=2147483000;
    DELETE FROM journal_vocab WHERE code='schema.attachment.activity';
    DELETE FROM journal_plots WHERE plot_uuid='schema-attachment-fk-plot';
  `);

  return {
    foreignKeys: foreignKeys(dbPath, 'journal_attachments'),
    validInsertSucceeded,
    validAttachmentCount,
    cascadeRemaining,
  };
}

function assertJournalAttachmentForeignKeyBehavior(dbPath, context) {
  assert.deepEqual(
    journalAttachmentForeignKeyFacts(dbPath),
    {
      foreignKeys: EXPECTED_JOURNAL_ATTACHMENT_FOREIGN_KEYS,
      validInsertSucceeded: true,
      validAttachmentCount: 1,
      cascadeRemaining: 0,
    },
    `${context} must attach to journal_entries and cascade entry deletion`
  );
}

function plotSettingsForeignKeyFacts(dbPath) {
  const orphanPlotUuid = 'schema-fk-orphan';
  const parentPlotUuid = 'schema-fk-parent';
  let orphanRejected = false;

  try {
    sqliteExec(dbPath, `
      PRAGMA foreign_keys=ON;
      INSERT INTO journal_plot_settings(
        plot_uuid,layout_code,updated_at,updated_by_principal_uuid
      ) VALUES (
        '${orphanPlotUuid}','open_field','2026-07-15T00:00:00.000Z','schema-test'
      );
    `);
  } catch (error) {
    orphanRejected = /FOREIGN KEY constraint failed/.test(
      String(error.stderr || error.message)
    );
  }

  sqliteExec(dbPath, `
    DELETE FROM journal_plot_settings WHERE plot_uuid='${orphanPlotUuid}';
    INSERT INTO journal_plots(plot_uuid,plot_code)
      VALUES ('${parentPlotUuid}','schema-fk-parent');
    INSERT INTO journal_plot_settings(
      plot_uuid,layout_code,updated_at,updated_by_principal_uuid
    ) VALUES (
      '${parentPlotUuid}','open_field','2026-07-15T00:00:00.000Z','schema-test'
    );
    PRAGMA foreign_keys=ON;
    DELETE FROM journal_plots WHERE plot_uuid='${parentPlotUuid}';
  `);
  const cascadeRemaining = sqliteJson(
    dbPath,
    `SELECT count(*) AS count FROM journal_plot_settings
      WHERE plot_uuid='${parentPlotUuid}';`
  )[0].count;
  sqliteExec(dbPath, `
    DELETE FROM journal_plot_settings WHERE plot_uuid='${parentPlotUuid}';
    DELETE FROM journal_plots WHERE plot_uuid='${parentPlotUuid}';
  `);

  return {
    foreignKeys: plotSettingsForeignKeys(dbPath),
    orphanRejected,
    cascadeRemaining,
  };
}

function assertPlotSettingsForeignKeyBehavior(dbPath, context) {
  assert.deepEqual(
    plotSettingsForeignKeyFacts(dbPath),
    {
      foreignKeys: EXPECTED_PLOT_SETTINGS_FOREIGN_KEYS,
      orphanRejected: true,
      cascadeRemaining: 0,
    },
    `${context} must reject orphan settings and cascade plot deletion`
  );
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

  assertPlotSettingsForeignKeyBehavior(dbPath, 'seed-built database');
  assertJournalSemanticForeignKeyBehavior(dbPath, 'seed-built database');
  assertJournalAttachmentForeignKeyBehavior(dbPath, 'seed-built database');

  const migrationDbPath = path.join(tmpDir, 'field-journal-migration.db');
  sqliteExec(migrationDbPath, `
    CREATE TABLE users(
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  sqliteExec(migrationDbPath, fs.readFileSync(fieldJournalMigrationPath, 'utf8'));
  assertPlotSettingsForeignKeyBehavior(migrationDbPath, '0018 migration-built database');
  assertJournalSemanticForeignKeyBehavior(migrationDbPath, '0018 migration-built database');
  assertJournalAttachmentForeignKeyBehavior(
    migrationDbPath,
    '0018 migration-built database'
  );

  for (const [index, bundledDbPath] of BUNDLED_DB_PATHS.entries()) {
    assert.deepEqual(
      plotSettingsForeignKeys(bundledDbPath),
      EXPECTED_PLOT_SETTINGS_FOREIGN_KEYS,
      `${path.relative(repoRoot, bundledDbPath)} journal_plot_settings foreign key`
    );
    const bundledCopyPath = path.join(tmpDir, `bundled-${index}.db`);
    fs.copyFileSync(bundledDbPath, bundledCopyPath);
    assertJournalSemanticForeignKeyBehavior(
      bundledCopyPath,
      path.relative(repoRoot, bundledDbPath)
    );
    assertJournalAttachmentForeignKeyBehavior(
      bundledCopyPath,
      path.relative(repoRoot, bundledDbPath)
    );
  }

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
      ['farmer_quick', 2],
      ['farmer_quick', 3],
      ['farmer_quick', 6],
      ['full_record', 1],
      ['full_record', 5],
      ['full_record', 6],
      ['full_record', 7],
      ['full_record', 8],
      ['research_observation', 1],
    ],
    'seed must contain the three template codes, with farmer_quick published at v1/v2 (frozen, historical), ' +
      'v3 (Slice BC quick_fields) and v6 (Slice F growth_stage_bbch quick-optional); full_record at v1 (frozen), ' +
      'v5 (Slice E activity-scoped operation fields), v6 (Slice F agronomy adds + review fold-in), v7 ' +
      '(journal capture-followups Slice 1, W1 relaxed irrigation_details requiredness) and v8 ' +
      '(treated-area-optional plan: treated_area no longer required anywhere)'
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

  // `templateDefinitions` resolves each code to its latest (currently-served)
  // version, which is now full_record@8 (treated-area-optional plan,
  // 2026-07-22): attr.treated_area is dropped from `required` on every dosing
  // activity below — no activity requires it anymore. It stays reachable
  // (visible-optional) via operation_fields_by_activity, asserted separately.
  const fullRecord = templateDefinitions.get('full_record');
  assert.deepEqual(fullRecord.activity_requirements.fertilization, {
    required: [],
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
    required: [],
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
    required: [],
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
    required: ['attr.crop'],
    required_any: [
      ['attr.amount_mass_area_product', 'attr.amount_count_area'],
    ],
  });
  assert.deepEqual(fullRecord.activity_requirements.planting_transplanting, {
    required: ['attr.crop'],
    required_any: [['attr.amount_count_area']],
  });
  assert.deepEqual(fullRecord.activity_requirements.harvest, {
    required: ['attr.crop', 'attr.harvest_area', 'attr.harvest_yield_area'],
    required_any: [],
  });
  // treated_area must still be reachable (visible-optional) via
  // operation_fields_by_activity for every activity it rendered on before,
  // plus the newly-added irrigation.
  for (const activity of [
    'irrigation', 'fertilization', 'fertigation', 'plant_protection_application',
    'weed_control_nonchemical', 'seeding', 'planting_transplanting',
    'tillage_soil_work', 'mowing',
  ]) {
    assert.ok(
      fullRecord.operation_fields_by_activity[activity].includes('attr.treated_area'),
      `full_record@8 operation_fields_by_activity.${activity} must still list attr.treated_area (visible-optional)`
    );
  }
  // full_record@8 must not add treated_area anywhere it was never shown.
  for (const activity of [
    'pruning', 'crop_care', 'harvest', 'sampling',
    'general_observation', 'pest_disease_observation', 'equipment_maintenance',
  ]) {
    assert.ok(
      !fullRecord.operation_fields_by_activity[activity].includes('attr.treated_area'),
      `full_record@8 operation_fields_by_activity.${activity} must not list attr.treated_area`
    );
  }

  // Version-pinned check: the frozen full_record@7 row (looked up directly,
  // not via the latest-wins Map above) must still require attr.treated_area
  // on the 5 dosing activities — old entries pinned to @7 keep their
  // original requiredness; only NEW entries created against @8 get the
  // relaxed behavior.
  const fullRecordV7Row = templates.find(
    (template) => template.code === 'full_record' && template.version === 7
  );
  assert.ok(fullRecordV7Row, 'frozen full_record@7 row must still exist');
  const fullRecordV7 = JSON.parse(fullRecordV7Row.definition_json);
  for (const activity of [
    'fertilization', 'fertigation', 'plant_protection_application',
    'seeding', 'planting_transplanting',
  ]) {
    assert.ok(
      fullRecordV7.activity_requirements[activity].required.includes('attr.treated_area'),
      `frozen full_record@7 activity_requirements.${activity}.required must still include attr.treated_area`
    );
  }

  assert.deepEqual(fullRecord.conditional_groups, [
    {
      code: 'irrigation_details',
      activity_codes: ['irrigation', 'fertigation'],
      // journal capture-followups Slice 1 (W1 Task 1.1a, full_record@7):
      // attr.measurement_source/attr.denominator moved from required to
      // optional (maintainer "relax to essentials" decision) — only the
      // amount kind stays required alongside required_any (the amount).
      required: ['attr.irrigation_amount_kind'],
      required_any: [[
        'attr.irrigation_depth',
        'attr.irrigation_volume_area',
        'attr.per_plant_volume',
      ]],
      optional: ['attr.measurement_source', 'attr.denominator', 'attr.actuation_expectation_id'],
    },
    // Slice F (F2): manual weather-at-application fallback, full_record@6+.
    {
      code: 'weather_at_application',
      activity_codes: ['plant_protection_application'],
      required: [],
      required_any: [],
      optional: [
        'attr.wind_speed',
        'attr.wind_direction',
        'attr.air_temperature',
        'attr.rel_humidity',
      ],
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
      ['greenhouse', 3],
      ['lysimeter', 1],
      ['lysimeter', 3],
      ['open_field', 1],
      ['open_field', 3],
      ['open_field', 8],
    ],
    'seed must contain the four generic layout codes, with open_field/greenhouse/lysimeter ' +
      'published at v1 (frozen, historical) and v3 (Slice BC static/reading split); open_field ' +
      'additionally at v8 (current, treated-area-optional plan: attr.treated_area dropped from ' +
      'minimum_fields), while greenhouse/lysimeter remain current at v3'
  );
  const parsedLayoutsByVersion = new Map(
    layouts.map((layout) => [`${layout.code}:${layout.version}`, JSON.parse(layout.definition_json)])
  );
  // `parsedLayouts` resolves each code to its latest (currently-served)
  // version, matching what buildCatalogModel/activeDefinition pick at
  // runtime — i.e. v3 for open_field/greenhouse/lysimeter.
  const parsedLayouts = new Map(
    layouts.map((layout) => [layout.code, JSON.parse(layout.definition_json)])
  );
  for (const [layoutCode, minimumFields] of Object.entries(EXPECTED_LAYOUT_MINIMUMS_V1)) {
    assert.deepEqual(
      parsedLayoutsByVersion.get(`${layoutCode}:1`).minimum_fields,
      minimumFields,
      `${layoutCode}@1 minimum-field contract (frozen)`
    );
  }
  for (const [layoutCode, minimumFields] of Object.entries(EXPECTED_LAYOUT_MINIMUMS_V3)) {
    assert.deepEqual(
      parsedLayouts.get(layoutCode).minimum_fields,
      minimumFields,
      `${layoutCode}@3 (current) minimum-field contract`
    );
  }
  for (const [layoutCode, staticFields] of Object.entries(EXPECTED_LAYOUT_STATIC_CONTEXT_V3)) {
    assert.deepEqual(
      parsedLayouts.get(layoutCode).static_context_fields,
      staticFields,
      `${layoutCode}@3 static_context_fields contract`
    );
  }
  for (const [layoutCode, readingFields] of Object.entries(EXPECTED_LAYOUT_READING_FIELDS_V3)) {
    assert.deepEqual(
      parsedLayouts.get(layoutCode).reading_fields,
      readingFields,
      `${layoutCode}@3 reading_fields contract`
    );
    for (const field of readingFields) {
      assert.ok(
        !parsedLayouts.get(layoutCode).minimum_fields.includes(field),
        `${layoutCode}@3 minimum_fields must not retain reading field ${field}`
      );
    }
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
  assert.equal(catalogState[0].catalog_version, 8, 'seed-built catalog version must be the current version (8, since the treated-area-optional plan: full_record@8 + open_field@8)');
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

  // 0019 is guarded to run only while catalog_version <= 1 (Task 27's
  // versioned delta design). The seed-built `dbPath` is now at the current
  // version (2), so the 0019-specific replay/conflict scenarios below need
  // an explicit "device that has only ever applied 0019" baseline: the
  // farmer_quick@2 row removed and catalog_state rolled back to v1's own
  // recorded hash (parsed straight out of 0019 so it can never drift from
  // the frozen file).
  const v1CatalogHashMatch = migrationText.match(/catalog_hash='([0-9a-f]{64})'/);
  assert.ok(v1CatalogHashMatch, '0019 must embed its own recorded catalog_hash');
  const v1CatalogHash = v1CatalogHashMatch[1];
  const v1OnlyDbPath = path.join(tmpDir, 'v1-only.db');
  fs.copyFileSync(dbPath, v1OnlyDbPath);
  sqliteExec(v1OnlyDbPath, `
    DELETE FROM journal_templates WHERE code='farmer_quick' AND version=2;
    UPDATE journal_catalog_state
       SET catalog_version=1, catalog_hash='${v1CatalogHash}', updated_at='2026-07-12T00:00:00.000Z'
     WHERE id=1;
  `);

  const replayDbPath = path.join(tmpDir, 'replay.db');
  fs.copyFileSync(v1OnlyDbPath, replayDbPath);
  sqliteExec(replayDbPath, `BEGIN IMMEDIATE;\n${migrationText}\nCOMMIT;\n`);
  const afterFirstReplay = catalogSnapshot(replayDbPath);
  sqliteExec(replayDbPath, `BEGIN IMMEDIATE;\n${migrationText}\nCOMMIT;\n`);
  assert.deepEqual(
    catalogSnapshot(replayDbPath),
    afterFirstReplay,
    '0019 must be exactly idempotent on a matching installed v1 catalog'
  );

  const conflictDbPath = path.join(tmpDir, 'conflict.db');
  fs.copyFileSync(v1OnlyDbPath, conflictDbPath);
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
  assert.ok(conflictError, '0019 must reject an immutable installed-row conflict');
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
    'replaying 0019 must not downgrade catalog state version 2'
  );
  assert.equal(
    sqliteJson(
      versionTwoDbPath,
      "SELECT count(*) AS count FROM journal_vocab_mappings WHERE term_code='irrigation';"
    )[0].count,
    0,
    'replaying 0019 must not mutate catalog data when a newer catalog is installed'
  );

  console.log(
    'test-journal-schema: OK (catalog v1 semantics, semantic FKs, guarded replay, seven-DB data parity)'
  );
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
