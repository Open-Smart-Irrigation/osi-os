'use strict';

const catalogCache = new WeakMap();
const catalogLoads = new WeakMap();
const MAX_STABLE_LOAD_ATTEMPTS = 3;

function queryAll(db, sql, params) {
  params = params || [];
  if (db && typeof db.prepare === 'function') {
    return Promise.resolve(db.prepare(sql).all(...params));
  }
  if (!db || typeof db.all !== 'function') {
    return Promise.reject(new TypeError('Database must provide prepare().all() or all()'));
  }
  return new Promise(function(resolve, reject) {
    db.all(sql, params, function(error, rows) {
      if (error) reject(error);
      else resolve(rows || []);
    });
  });
}

function queryOne(db, sql, params) {
  params = params || [];
  if (db && typeof db.prepare === 'function') {
    return Promise.resolve(db.prepare(sql).get(...params));
  }
  if (!db || typeof db.get !== 'function') {
    return Promise.reject(new TypeError('Database must provide prepare().get() or get()'));
  }
  return new Promise(function(resolve, reject) {
    db.get(sql, params, function(error, row) {
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

async function readCoreCatalogTables(db) {
  const [vocabRows, mappingRows, templateRows, layoutRows, productRows] = await Promise.all([
    queryAll(db, "SELECT * FROM journal_vocab WHERE scope='core' ORDER BY code"),
    queryAll(db,
      "SELECT m.* FROM journal_vocab_mappings AS m " +
      "JOIN journal_vocab AS v ON v.code=m.term_code WHERE v.scope='core' " +
      'ORDER BY m.term_code,m.scheme_uri,m.mapping_role,m.external_id'),
    queryAll(db, 'SELECT * FROM journal_templates ORDER BY code, version'),
    queryAll(db, 'SELECT * FROM journal_layouts ORDER BY code, version'),
    queryAll(db, "SELECT * FROM journal_products WHERE scope='core' ORDER BY product_uuid"),
  ]);
  return { vocabRows, mappingRows, templateRows, layoutRows, productRows };
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
    mappings: rows.mappingRows || [],
  };
}

async function loadStableCatalog(db, initialState) {
  let state = initialState;
  for (let attempt = 0; attempt < MAX_STABLE_LOAD_ATTEMPTS; attempt += 1) {
    const cached = cachedForState(db, state);
    if (cached) return cached;
    const rows = await readCoreCatalogTables(db);
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

async function loadCoreCatalog(db) {
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

async function loadScopedRows(db, principal) {
  if (!principal) return { vocabRows: [], mappingRows: [], productRows: [] };
  const owner = principal.owner_user_uuid;
  const gateway = principal.gateway_device_eui;
  if (typeof owner !== 'string' || !owner || typeof gateway !== 'string' || !gateway) {
    throw new TypeError('Scoped journal catalog requires owner and gateway identity');
  }
  const vocabRows = await queryAll(
    db,
    "SELECT * FROM journal_vocab WHERE scope='custom' AND owner_user_uuid=? " +
      'AND gateway_device_eui=? AND deleted_at IS NULL ORDER BY code',
    [owner, gateway]
  );
  const codes = vocabRows.map(function(row) { return row.code; });
  let mappingRows = [];
  if (codes.length) {
    mappingRows = await queryAll(
      db,
      'SELECT * FROM journal_vocab_mappings WHERE term_code IN (' +
        codes.map(function() { return '?'; }).join(',') +
      ') ORDER BY term_code,scheme_uri,mapping_role,external_id',
      codes
    );
  }
  const productRows = await queryAll(
    db,
    "SELECT * FROM journal_products WHERE scope='farm' AND owner_user_uuid=? " +
      'AND gateway_device_eui=? AND deleted_at IS NULL ORDER BY product_uuid',
    [owner, gateway]
  );
  return { vocabRows, mappingRows, productRows };
}

async function loadCatalog(db, principal) {
  const core = await loadCoreCatalog(db);
  if (!principal) return core;
  const scoped = await loadScopedRows(db, principal);
  const vocabByCode = new Map(core.vocabByCode);
  for (const row of scoped.vocabRows) {
    const parsed = parseVocabRow(row);
    vocabByCode.set(parsed.code, parsed);
  }
  const products = new Map(core.products);
  for (const row of scoped.productRows) {
    const parsed = parseProductRow(row);
    products.set(parsed.product_uuid, parsed);
  }
  return {
    version: core.version,
    hash: core.hash,
    vocabByCode,
    templates: core.templates,
    layouts: core.layouts,
    products,
    mappings: core.mappings.concat(scoped.mappingRows),
  };
}

module.exports = { loadCatalog };
