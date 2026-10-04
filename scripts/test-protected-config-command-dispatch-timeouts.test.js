'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const TARGET = path.join(__dirname, 'test-protected-config-command-dispatch.js');
const EXPECTED_SITES = new Set([
  'dedupeProbe',
  'protectedChainProbe',
  'helperRun',
  'ledgerRun',
  'bootstrapRun',
]);
const MIN_TIMEOUT_MS = 180000;
const SPAWN_SYNC_RE = /\bspawnSync\s*\(/g;
const NAMED_SITE_RE = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*spawnSync\s*\(/g;
const OPTIONS_RE = /^\{\s*cwd\s*:\s*ROOT\s*,\s*encoding\s*:\s*'utf8'\s*,\s*timeout\s*:\s*([0-9]+)\s*,?\s*\}$/s;

function inspectSpawnSyncSites(source) {
  // Deliberately scan raw text. A token in a string, comment, regex, or probe
  // template is an unreviewed executable-looking site and fails closed.
  const calls = [...source.matchAll(SPAWN_SYNC_RE)];
  assert.equal(calls.length, EXPECTED_SITES.size, 'raw spawnSync call count changed');

  const declarations = [...source.matchAll(NAMED_SITE_RE)];
  assert.equal(declarations.length, EXPECTED_SITES.size, 'named spawnSync site count changed');
  const names = new Set(declarations.map((match) => match[1]));
  assert.deepEqual(names, EXPECTED_SITES, 'spawnSync sites must be the approved named probes');

  const sites = [];
  for (const declaration of declarations) {
    const name = declaration[1];
    const callIndex = declaration.index + declaration[0].lastIndexOf('spawnSync');
    assert.ok(calls.some((call) => call.index === callIndex), `${name} is not a raw spawnSync site`);

    // Each shipped call has one stable post-call assertion sentinel. Counting
    // raw occurrences before locating it prevents a fake sentinel in an
    // embedded comment from redirecting the options extraction.
    const sentinelText = `assert.equal(${name}.status`;
    const sentinelMatches = [...source.matchAll(new RegExp(sentinelText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))];
    assert.equal(sentinelMatches.length, 1, `${name} status sentinel count changed`);
    const sentinel = sentinelMatches[0].index;
    assert.ok(sentinel > declaration.index, `${name} status sentinel is missing`);
    const callSource = source.slice(declaration.index, sentinel);
    const optionsMatch = callSource.match(/\],\s*(\{[\s\S]*\})\);\s*$/);
    assert.ok(optionsMatch, `${name} must end with an inline options object`);
    const optionShape = optionsMatch[1].match(OPTIONS_RE);
    assert.ok(optionShape, `${name} options must be exactly cwd, encoding, and timeout`);
    const timeout = Number(optionShape[1]);
    assert.ok(Number.isSafeInteger(timeout) && timeout >= MIN_TIMEOUT_MS, `${name} timeout must be a safe integer >= ${MIN_TIMEOUT_MS}`);
    sites.push({ name, timeout });
  }

  return sites;
}

test('protected dispatch probes use a numeric timeout of at least 180 seconds at every approved call site', () => {
  const source = fs.readFileSync(TARGET, 'utf8');
  const sites = inspectSpawnSyncSites(source);
  assert.equal(sites.length, EXPECTED_SITES.size);
  assert.ok(sites.every((site) => site.timeout >= MIN_TIMEOUT_MS));
});

test('protected dispatch timeout guard rejects missing, extra, and unsupported sites/options', () => {
  const source = fs.readFileSync(TARGET, 'utf8');
  const validSource = source.replace(/timeout:\s*\d+/g, 'timeout: 180000');
  assert.doesNotThrow(() => inspectSpawnSyncSites(validSource.replace('timeout: 180000', 'timeout: 180001')));
  assert.throws(
    () => inspectSpawnSyncSites(validSource.replace('const dedupeProbe = spawnSync', 'const removedDedupeProbe = 0')),
    /raw spawnSync call count|named spawnSync site count|approved named probes/i,
  );
  assert.throws(
    () => inspectSpawnSyncSites(`${validSource}\nconst unrecognizedProbe = spawnSync(process.execPath, [], { timeout: 180000 });\n`),
    /raw spawnSync call count|named spawnSync site count|approved named probes/i,
  );
  assert.throws(
    () => inspectSpawnSyncSites(validSource.replace('timeout: 180000', 'timeout: configuredTimeout')),
    /options must be exactly|timeout must/i,
  );
  assert.throws(
    () => inspectSpawnSyncSites(validSource.replace('timeout: 180000', 'timeout: 180000, timeout: 180000')),
    /options must be exactly/i,
  );
  assert.throws(
    () => inspectSpawnSyncSites(validSource.replace('cwd: ROOT', '...baseOptions')),
    /options must be exactly/i,
  );
  assert.throws(
    () => inspectSpawnSyncSites(validSource.replace("encoding: 'utf8'", '"encoding": \'utf8\'')),
    /options must be exactly/i,
  );
  assert.throws(
    () => inspectSpawnSyncSites(validSource.replace('cwd: ROOT', '[cwdKey]: ROOT')),
    /options must be exactly/i,
  );
  assert.throws(
    () => inspectSpawnSyncSites(validSource.replace('cwd: ROOT', 'signal: ROOT')),
    /options must be exactly/i,
  );
  const fakeComment = [
    '/*',
    '], { cwd: ROOT, encoding: \'utf8\', timeout: 180000 });',
    'assert.equal(dedupeProbe.status, 0);',
    '*/',
  ].join('\n');
  const loweredRealTimeout = validSource.replace('timeout: 180000', 'timeout: 60000');
  assert.throws(
    () => inspectSpawnSyncSites(loweredRealTimeout.replace(
      "const dedupeProbe = spawnSync(process.execPath, ['-e', `",
      "const dedupeProbe = spawnSync(process.execPath, ['-e', `" + fakeComment + '\n',
    )),
    /status sentinel count changed|timeout must/i,
  );
});

test('protected dispatch timeout guard fails closed on raw hidden spawnSync tokens', () => {
  const source = fs.readFileSync(TARGET, 'utf8');
  for (const hidden of [
    'const hidden = "spawnSync(process.execPath)";',
    '// spawnSync(process.execPath)',
    'const hidden = /spawnSync(process\\.execPath)/;',
    "const hidden = `${spawnSync(process.execPath)}`;",
  ]) {
    assert.throws(
      () => inspectSpawnSyncSites(`${source}\n${hidden}\n`),
      /raw spawnSync call count|named spawnSync site count|approved named probes/i,
      hidden,
    );
  }
});
