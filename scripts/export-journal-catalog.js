#!/usr/bin/env node
'use strict';

// Emits the vendorable journal-catalog artifact: the same rows, in the same DTO
// shape and the same order, that the edge serves at
// GET /api/journal/catalog?include=definitions — restricted to the global
// (non-principal) rows, since a build-time file cannot carry a caller's
// scope='custom' vocab or scope='farm' products (reading 6 deviation).
// osi-server vendors this file and serves it to its GUI,
// which then runs the same catalogModel/templateEngine the edge GUI runs.
// Source of truth is the shipped database/farming.db, whose catalog rows are
// pinned column-by-column by scripts/test-journal-schema.js.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(REPO_ROOT, 'database/farming.db');
const OUT_PATH = path.join(
  REPO_ROOT,
  'docs/contracts/journal-catalog/journal-catalog.json'
);

function sqliteJson(sql) {
  const stdout = execFileSync('sqlite3', ['-json', DB_PATH, sql], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trim() ? JSON.parse(stdout) : [];
}

// Mirrors osi-journal/api.js parsedJson exactly (null-in => fallback out).
function parsedJson(raw, fallback) {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

// Mirrors osi-journal/catalog.js safeJson: anything that is not a plain object
// records the column name in catalog_errors instead of being silently dropped.
// The shipped catalog is clean today; hardcoding `catalog_errors: []` would
// export a future malformed row as if it were fine (L2).
function safeJson(raw, fallback, field, errors) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (_) {
    // Fall through: the catalog stays loadable, the defect is recorded.
  }
  errors.push(field);
  return fallback;
}

// osi-journal/catalog.js parseVocabRow + api.js catalogDto (includeDefinitions).
// Note the two-stage shape the edge has: parse*Row derives catalog_errors from
// safeJson, then catalogDto re-derives `constraints` with parsedJson(..., null),
// so a NULL constraints_json emits `null` (not `{}`) and contributes no error.
function vocabDto(row) {
  const errors = [];
  safeJson(row.labels_json, {}, 'labels_json', errors);
  if (row.constraints_json != null) {
    safeJson(row.constraints_json, {}, 'constraints_json', errors);
  }
  const out = Object.assign({}, row, {
    catalog_errors: errors,
    labels: parsedJson(row.labels_json, {}),
    constraints: parsedJson(row.constraints_json, null),
  });
  delete out.labels_json;
  delete out.constraints_json;
  return out;
}

function definitionDto(row) {
  const errors = [];
  safeJson(row.labels_json, {}, 'labels_json', errors);
  safeJson(row.definition_json, {}, 'definition_json', errors);
  const out = Object.assign({}, row, {
    catalog_errors: errors,
    labels: parsedJson(row.labels_json, {}),
    definition: parsedJson(row.definition_json, {}),
  });
  delete out.labels_json;
  delete out.definition_json;
  return out;
}

function productDto(row) {
  const errors = [];
  safeJson(row.composition_json, {}, 'composition_json', errors);
  const out = Object.assign({}, row, {
    catalog_errors: errors,
    composition: parsedJson(row.composition_json, {}),
  });
  delete out.composition_json;
  return out;
}

function mappingDto(row) {
  const out = Object.assign({}, row);
  delete out.id;
  return out;
}

function buildCatalogArtifact() {
  const state = sqliteJson(
    'SELECT catalog_version, catalog_hash FROM journal_catalog_state WHERE id=1'
  )[0];
  if (!state) throw new Error('journal_catalog_state row 1 is missing');

  // The SQL ORDER BY clauses match osi-journal/catalog.js readCoreCatalogTables,
  // but SQLite's BINARY collation is NOT api.js catalogDto's ordering: catalogDto
  // re-sorts vocab/templates/layouts/products in JS with localeCompare, and the
  // two disagree on the vocab list ('unit.m2_area' vs 'unit.m_per_s'). Apply the
  // same JS comparators so the artifact is the served payload's byte order.
  // Mappings are the one list catalogDto does NOT re-sort — it keeps the SQL
  // order — so this leaves them alone.
  const byCode = (left, right) => left.code.localeCompare(right.code);
  const byCodeVersion = (left, right) =>
    left.code.localeCompare(right.code) || left.version - right.version;

  const vocab = sqliteJson(
    "SELECT * FROM journal_vocab WHERE scope='core' ORDER BY code"
  ).map(vocabDto).sort(byCode);
  const mappings = sqliteJson(
    'SELECT m.* FROM journal_vocab_mappings AS m ' +
    "JOIN journal_vocab AS v ON v.code=m.term_code WHERE v.scope='core' " +
    'ORDER BY m.term_code,m.scheme_uri,m.mapping_role,m.external_id'
  ).map(mappingDto);
  const templates = sqliteJson(
    'SELECT * FROM journal_templates ORDER BY code, version'
  ).map(definitionDto).sort(byCodeVersion);
  const layouts = sqliteJson(
    'SELECT * FROM journal_layouts ORDER BY code, version'
  ).map(definitionDto).sort(byCodeVersion);
  const products = sqliteJson(
    "SELECT * FROM journal_products WHERE scope='core' ORDER BY product_uuid"
  ).map(productDto)
    .sort((left, right) => left.product_uuid.localeCompare(right.product_uuid));

  return {
    catalog_version: Number(state.catalog_version),
    catalog_hash: String(state.catalog_hash),
    vocab,
    templates,
    layouts,
    products,
    mappings,
  };
}

function artifactText(artifact) {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

function main(argv) {
  const check = argv.length === 1 && argv[0] === '--check';
  if (argv.length && !check) {
    throw new Error(`unsupported argument(s): ${argv.join(' ')}`);
  }
  const artifact = buildCatalogArtifact();
  const expected = artifactText(artifact);
  if (check) {
    const actual = fs.existsSync(OUT_PATH)
      ? fs.readFileSync(OUT_PATH, 'utf8')
      : '';
    if (actual !== expected) {
      throw new Error(
        'docs/contracts/journal-catalog/journal-catalog.json is stale; ' +
        'run node scripts/export-journal-catalog.js and re-vendor to osi-server'
      );
    }
    console.log(`export-journal-catalog: OK (v${artifact.catalog_version})`);
    return;
  }
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, expected);
  console.log(
    `export-journal-catalog: wrote v${artifact.catalog_version} ` +
    `(${artifact.catalog_hash})`
  );
}

module.exports = {
  buildCatalogArtifact, artifactText, vocabDto, definitionDto, productDto,
  DB_PATH, OUT_PATH,
};

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`export-journal-catalog: FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
