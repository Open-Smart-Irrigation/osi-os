#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const core = require('./journal-catalog-core');
const source = require('../docs/superpowers/specs/agroscope-open-field/catalog.json');
const generator = require('./generate-journal-catalog');

function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
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

for (const exportName of [
  'compileCatalog',
  'validateCore',
  'validateSource',
  'replaceSeedBlock',
  'expectedManifestText',
  'writeGeneratedArtifacts',
]) {
  assert.equal(
    typeof generator[exportName],
    'function',
    `generator must export ${exportName} as a testable compiler/validation seam`
  );
}

const artifactPaths = [
  'database/migrations/ordered/0019__journal_catalog_v1.sql',
  'database/seed-blank.sql',
  'database/migrations/ordered/CHECKSUMS.json',
].map((relativePath) => path.join(repoRoot, relativePath));
const beforeCompile = artifactPaths.map((artifactPath) => ({
  content: fs.readFileSync(artifactPath),
  mtimeMs: fs.statSync(artifactPath).mtimeMs,
}));

const compiled = generator.compileCatalog(core, source);
const compiledAgain = generator.compileCatalog(core, source);
assert.equal(compiled.migration, compiledAgain.migration, 'pure compilation must be deterministic');
assert.equal(compiled.seedBlock, compiledAgain.seedBlock, 'seed compilation must be deterministic');
assert.deepEqual(
  artifactPaths.map((artifactPath) => ({
    content: fs.readFileSync(artifactPath),
    mtimeMs: fs.statSync(artifactPath).mtimeMs,
  })),
  beforeCompile,
  'pure compilation must not read-modify-write repository artifacts'
);

const hashInput = compiled.rows.map((row) => ({
  table: row.table,
  key: row.key,
  columns: row.columns,
  values: row.values,
}));
assert.equal(
  compiled.catalogHash,
  sha256(stableStringify(hashInput)),
  'catalog hash must be independently reproducible from generated row content'
);
const mappingRows = compiled.rows.filter((row) => row.table === 'journal_vocab_mappings');
assert.equal(mappingRows.length, 7, 'compiled row content must include seven standard mappings');

const changedCore = {
  ...core,
  activities: core.activities.map((activity) => {
    if (activity.code !== 'irrigation') return activity;
    return {
      ...activity,
      mappings: activity.mappings.map((mapping) => ({
        ...mapping,
        external_id: `${mapping.external_id}_TEST_MUTATION`,
      })),
    };
  }),
};
assert.notEqual(
  generator.compileCatalog(changedCore, source).catalogHash,
  compiled.catalogHash,
  'changing a standard mapping must change the generated catalog hash'
);

const sourceCategoryOwners = new Map();
for (const activity of core.activities) {
  for (const category of activity.agroscope_categories || []) {
    assert.ok(!sourceCategoryOwners.has(category), `duplicate Agroscope category policy ${category}`);
    sourceCategoryOwners.set(category, activity.code);
  }
}
assert.deepEqual(
  [...sourceCategoryOwners.keys()].sort(),
  source.categories.map((category) => category.code).sort(),
  'all category mapping policy must live on core activity rows'
);
const sourceUnitLabels = new Set();
for (const unit of core.units) {
  for (const binding of unit.source_bindings || []) sourceUnitLabels.add(binding.label);
}
assert.deepEqual(
  [...sourceUnitLabels].sort(),
  [...source.all_units].sort(),
  'all Agroscope unit binding policy must live on semantic core unit rows'
);
const generatorSource = fs.readFileSync(path.join(__dirname, 'generate-journal-catalog.js'), 'utf8');
assert.match(
  generatorSource,
  /if \(require\.main === module\)/,
  'requiring the generator must not execute its CLI entry point'
);
for (const forbiddenPolicyName of [
  'CATEGORY_ACTIVITY',
  'UNIT_BINDINGS',
  'validateRepresentativeBindings',
]) {
  assert.ok(
    !generatorSource.includes(forbiddenPolicyName),
    `generator must not retain hard-coded policy ${forbiddenPolicyName}`
  );
}

const markerFreeSeed = '-- base seed\n';
const withOneBlock = generator.replaceSeedBlock(markerFreeSeed, compiled.seedBlock);
assert.equal(
  withOneBlock.split('-- BEGIN GENERATED JOURNAL CATALOG V1').length - 1,
  1,
  'marker-free seed gains exactly one begin marker'
);
assert.equal(
  withOneBlock.split('-- END GENERATED JOURNAL CATALOG V1').length - 1,
  1,
  'marker-free seed gains exactly one end marker'
);
assert.throws(
  () => generator.replaceSeedBlock(withOneBlock + '\n' + compiled.seedBlock, compiled.seedBlock),
  /duplicate|more than one/i,
  'duplicate complete generated seed blocks must be rejected'
);
assert.throws(
  () => generator.replaceSeedBlock(
    '-- BEGIN GENERATED JOURNAL CATALOG V1\nincomplete\n',
    compiled.seedBlock
  ),
  /incomplete|marker/i,
  'an incomplete generated seed block must be rejected'
);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-generator-'));
try {
  const paths = {
    migrationPath: path.join(tmpDir, '0019__journal_catalog_v1.sql'),
    seedPath: path.join(tmpDir, 'seed-blank.sql'),
    manifestPath: path.join(tmpDir, 'CHECKSUMS.json'),
  };
  fs.writeFileSync(paths.seedPath, markerFreeSeed);
  fs.writeFileSync(paths.manifestPath, '{}\n');
  generator.writeGeneratedArtifacts(compiled, paths);
  assert.equal(fs.readFileSync(paths.migrationPath, 'utf8'), compiled.migration);
  assert.equal(
    fs.readFileSync(paths.seedPath, 'utf8'),
    generator.replaceSeedBlock(markerFreeSeed, compiled.seedBlock)
  );

  const installedMigration = fs.readFileSync(paths.migrationPath, 'utf8');
  const installedSeed = fs.readFileSync(paths.seedPath, 'utf8');
  const installedManifest = fs.readFileSync(paths.manifestPath, 'utf8');
  fs.writeFileSync(paths.migrationPath, '-- differing installed 0019\n');
  assert.throws(
    () => generator.writeGeneratedArtifacts(compiled, paths),
    /new migration|refus|exists and differs/i,
    'normal generator writes must refuse to replace a differing installed 0019'
  );
  assert.equal(
    fs.readFileSync(paths.migrationPath, 'utf8'),
    '-- differing installed 0019\n',
    'refusal must leave the installed migration untouched'
  );
  assert.equal(
    fs.readFileSync(paths.seedPath, 'utf8'),
    installedSeed,
    'migration refusal must leave the seed untouched'
  );
  assert.equal(
    fs.readFileSync(paths.manifestPath, 'utf8'),
    installedManifest,
    'migration refusal must leave the checksum manifest untouched'
  );
  fs.writeFileSync(paths.migrationPath, installedMigration);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('test-journal-catalog-generator: OK (pure compiler, hash, markers, immutable write guard)');
