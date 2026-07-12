'use strict';

const catalogCache = new WeakMap();
const catalogLoads = new WeakMap();
const MAX_STABLE_LOAD_ATTEMPTS = 3;

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

function sameState(left, right) {
  return Boolean(left) && Boolean(right) &&
    left.catalog_version === right.catalog_version &&
    left.catalog_hash === right.catalog_hash;
}

function stateKey(state) {
  return String(state.catalog_version) + ':' + String(state.catalog_hash);
}

function readState(db) {
  return queryOne(
    db,
    'SELECT catalog_version, catalog_hash FROM journal_catalog_state WHERE id = 1'
  );
}

function cachedForState(db, state) {
  const cached = catalogCache.get(db);
  return cached && cached.version === state.catalog_version && cached.hash === state.catalog_hash
    ? cached
    : null;
}

async function readCatalogTables(db) {
  const [vocabRows, templateRows, layoutRows, productRows] = await Promise.all([
    queryAll(db, 'SELECT * FROM journal_vocab ORDER BY code'),
    queryAll(db, 'SELECT * FROM journal_templates ORDER BY code, version'),
    queryAll(db, 'SELECT * FROM journal_layouts ORDER BY code, version'),
    queryAll(db, 'SELECT * FROM journal_products ORDER BY product_uuid'),
  ]);
  return { vocabRows, templateRows, layoutRows, productRows };
}

function buildCatalog(state, rows) {
  const vocabByCode = new Map(rows.vocabRows.map(function(row) {
    const parsed = parseVocabRow(row);
    return [parsed.code, parsed];
  }));
  const templates = indexVersioned(rows.templateRows.map(parseDefinitionRow));
  const layouts = indexVersioned(rows.layoutRows.map(parseDefinitionRow));
  const products = new Map(rows.productRows.map(function(row) {
    const parsed = parseProductRow(row);
    return [parsed.product_uuid, parsed];
  }));

  return {
    version: state.catalog_version,
    hash: state.catalog_hash,
    vocabByCode,
    templates,
    layouts,
    products,
  };
}

async function loadStableCatalog(db, initialState) {
  let state = initialState;
  for (let attempt = 0; attempt < MAX_STABLE_LOAD_ATTEMPTS; attempt += 1) {
    const cached = cachedForState(db, state);
    if (cached) return cached;
    const rows = await readCatalogTables(db);
    const endState = await readState(db);
    if (!endState) throw new Error('Journal catalog state is missing');
    if (sameState(state, endState)) {
      const catalog = buildCatalog(state, rows);
      catalogCache.set(db, catalog);
      return catalog;
    }
    state = endState;
  }
  throw new Error('Journal catalog changed during load after ' + MAX_STABLE_LOAD_ATTEMPTS + ' attempts');
}

async function loadCatalog(db) {
  const state = await readState(db);
  if (!state) throw new Error('Journal catalog state is missing');
  const cached = cachedForState(db, state);
  if (cached) return cached;

  let loads = catalogLoads.get(db);
  if (!loads) {
    loads = new Map();
    catalogLoads.set(db, loads);
  }
  const key = stateKey(state);
  if (loads.has(key)) return loads.get(key);

  const pending = loadStableCatalog(db, state);
  loads.set(key, pending);
  try {
    return await pending;
  } finally {
    if (loads.get(key) === pending) loads.delete(key);
    if (loads.size === 0) catalogLoads.delete(db);
  }
}

module.exports = { loadCatalog };
