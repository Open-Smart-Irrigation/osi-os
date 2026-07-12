'use strict';

const catalogCache = new WeakMap();

function queryAll(db, sql) {
  if (db && typeof db.prepare === 'function') {
    return Promise.resolve(db.prepare(sql).all());
  }
  if (!db || typeof db.all !== 'function') {
    return Promise.reject(new TypeError('Database must provide prepare().all() or all()'));
  }
  return new Promise(function(resolve, reject) {
    db.all(sql, [], function(error, rows) {
      if (error) reject(error);
      else resolve(rows || []);
    });
  });
}

function queryOne(db, sql) {
  if (db && typeof db.prepare === 'function') {
    return Promise.resolve(db.prepare(sql).get());
  }
  if (!db || typeof db.get !== 'function') {
    return Promise.reject(new TypeError('Database must provide prepare().get() or get()'));
  }
  return new Promise(function(resolve, reject) {
    db.get(sql, [], function(error, row) {
      if (error) reject(error);
      else resolve(row || null);
    });
  });
}

function safeJson(raw, fallback, field, errors) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (_) {
    // The catalog stays loadable; authoritative validation surfaces this defect.
  }
  errors.push(field);
  return fallback;
}

function parseVocabRow(row) {
  const errors = [];
  return Object.assign({}, row, {
    labels: safeJson(row.labels_json, {}, 'labels_json', errors),
    constraints: row.constraints_json == null
      ? {}
      : safeJson(row.constraints_json, {}, 'constraints_json', errors),
    catalog_errors: errors,
  });
}

function parseDefinitionRow(row) {
  const errors = [];
  return Object.assign({}, row, {
    labels: safeJson(row.labels_json, {}, 'labels_json', errors),
    definition: safeJson(row.definition_json, {}, 'definition_json', errors),
    catalog_errors: errors,
  });
}

function parseProductRow(row) {
  const errors = [];
  return Object.assign({}, row, {
    composition: safeJson(row.composition_json, {}, 'composition_json', errors),
    catalog_errors: errors,
  });
}

function indexVersioned(rows) {
  // Append-only definitions must remain addressable by both stable code and
  // the exact version pinned on an entry: Map<code, Map<version, row>>.
  const indexed = new Map();
  for (const row of rows) {
    if (!indexed.has(row.code)) indexed.set(row.code, new Map());
    indexed.get(row.code).set(row.version, row);
  }
  return indexed;
}

async function loadCatalog(db) {
  const state = await queryOne(
    db,
    'SELECT catalog_version, catalog_hash FROM journal_catalog_state WHERE id = 1'
  );
  if (!state) throw new Error('Journal catalog state is missing');

  const cached = catalogCache.get(db);
  if (cached && cached.version === state.catalog_version && cached.hash === state.catalog_hash) {
    return cached;
  }

  const [vocabRows, templateRows, layoutRows, productRows] = await Promise.all([
    queryAll(db, 'SELECT * FROM journal_vocab ORDER BY code'),
    queryAll(db, 'SELECT * FROM journal_templates ORDER BY code, version'),
    queryAll(db, 'SELECT * FROM journal_layouts ORDER BY code, version'),
    queryAll(db, 'SELECT * FROM journal_products ORDER BY product_uuid'),
  ]);

  const vocabByCode = new Map(vocabRows.map(function(row) {
    const parsed = parseVocabRow(row);
    return [parsed.code, parsed];
  }));
  const templates = indexVersioned(templateRows.map(parseDefinitionRow));
  const layouts = indexVersioned(layoutRows.map(parseDefinitionRow));
  const products = new Map(productRows.map(function(row) {
    const parsed = parseProductRow(row);
    return [parsed.product_uuid, parsed];
  }));

  const catalog = {
    version: state.catalog_version,
    hash: state.catalog_hash,
    vocabByCode,
    templates,
    layouts,
    products,
  };
  catalogCache.set(db, catalog);
  return catalog;
}

module.exports = { loadCatalog };
