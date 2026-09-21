#!/usr/bin/env node
'use strict';

// Canonical source for legacy runtime-created trigger DDL. The JSON has one
// tokenized SQL definition per trigger; owner metadata contains only ordered
// DROP/CREATE references. Applied migrations are read-only inputs.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const REPO_ROOT = path.resolve(__dirname, '..');
const CANONICAL_PATH = path.join(__dirname, 'sync-trigger-source.json');
const SEED_PATH = path.join(REPO_ROOT, 'database/seed-blank.sql');
const FLOW_PATHS = [
  path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'),
  path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'),
];
const FIXED_EUI = "'0016C001F11715E2'";
const TEST_EUI = "'ABCDEF0123456789'";
const TOKEN = '<GATEWAY_EUI>';

function readArray(flowPath, nodeId, variable, gatewaySql = TEST_EUI) {
  const flows = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
  const node = flows.find((entry) => entry && entry.id === nodeId);
  if (!node || typeof node.func !== 'string') throw new Error(`${flowPath}: ${nodeId} not found`);
  const match = node.func.match(new RegExp(`const\\s+${variable}\\s*=\\s*(\\[[\\s\\S]*?\\n\\]);`));
  if (!match) throw new Error(`${flowPath}: ${variable} array not found in ${nodeId}`);
  try {
    return new Function('gatewaySql', `'use strict'; return (${match[1]});`)(gatewaySql);
  } catch (error) {
    throw new Error(`${flowPath}: ${nodeId}.${variable} does not evaluate: ${error.message}`);
  }
}

function triggerName(sql) {
  const match = String(sql).match(/CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)/i);
  return match ? match[1] : null;
}

function canonicalSql(sql) {
  let value = String(sql || '').replaceAll(FIXED_EUI, `'${TOKEN}'`).replaceAll(TEST_EUI, `'${TOKEN}'`);
  value = value.replace(/\bIF\s+NOT\s+EXISTS\b/gi, ' ');
  value = value.replace(/\s+/g, ' ').replace(/\s+\(/g, '(').replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')').replace(/\s*,\s*/g, ', ')
    .replace(/\s*(?<![<>=!])=(?!=)\s*/g, ' = ')
    .replace(/([A-Za-z0-9_)])\s*\*\s*([A-Za-z0-9_(])/g, '$1 * $2');
  return value.replace(/;\s*$/, '').trim();
}

function tokenizedRuntimeSql(sql) { return String(sql).trim().replaceAll(TEST_EUI, `'${TOKEN}'`); }

function statementRefs(statements) {
  return statements.map((statement, position) => {
    const text = String(statement).trim();
    const drop = text.match(/^DROP\s+TRIGGER\s+IF\s+EXISTS\s+([A-Za-z0-9_]+)/i);
    if (drop) return { kind: 'drop', name: drop[1], position };
    const name = triggerName(text);
    if (name) return { kind: 'create', name, position };
    return null;
  }).filter(Boolean);
}

function seedTriggerMap(seedPath = SEED_PATH) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(fs.readFileSync(seedPath, 'utf8'));
    return new Map(db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger'").all().map((row) => [row.name, row.sql]));
  } finally { db.close(); }
}

function referenceSnapshot({ seedPath = SEED_PATH, flowPaths = FLOW_PATHS } = {}) {
  const sync = readArray(flowPaths[0], 'sync-init-fn', 'triggers', TEST_EUI);
  const dendro = readArray(flowPaths[0], 'dendro-compute-fn', 'MIGS', TEST_EUI);
  const syncRefs = statementRefs(sync);
  const dendroRefs = statementRefs(dendro);
  const sqlByName = new Map();
  for (const statement of [...sync, ...dendro]) {
    const name = triggerName(statement);
    if (name) sqlByName.set(name, tokenizedRuntimeSql(statement));
  }
  const seed = seedTriggerMap(seedPath);
  const names = [...new Set([...syncRefs, ...dendroRefs].filter((ref) => ref.kind === 'create').map((ref) => ref.name))].sort();
  const triggers = names.map((name) => {
    const sql = sqlByName.get(name);
    if (!sql) throw new Error(`runtime trigger ${name} has no SQL definition`);
    if (!seed.has(name)) throw new Error(`seed-blank.sql: runtime trigger ${name} is missing`);
    return { name, sql };
  });
  return {
    formatVersion: 2,
    substitutionToken: `'${TOKEN}'`,
    owners: [
      { nodeId: 'sync-init-fn', variable: 'triggers', statements: syncRefs },
      { nodeId: 'dendro-compute-fn', variable: 'MIGS', statements: dendroRefs },
    ],
    triggers,
  };
}

function loadCanonical(canonicalPath = CANONICAL_PATH) {
  if (!fs.existsSync(canonicalPath)) throw new Error(`${canonicalPath}: canonical source is missing`);
  const source = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));
  if (source.formatVersion !== 2 || source.substitutionToken !== `'${TOKEN}'`) throw new Error(`${canonicalPath}: unsupported canonical source format`);
  if (!Array.isArray(source.triggers) || !source.triggers.length || source.triggers.some((entry) => !entry.name || typeof entry.sql !== 'string')) throw new Error(`${canonicalPath}: every trigger must have exactly one SQL definition`);
  if (new Set(source.triggers.map((entry) => entry.name)).size !== source.triggers.length) throw new Error(`${canonicalPath}: duplicate trigger SQL definitions`);
  if (!Array.isArray(source.owners) || source.owners.length !== 2 || source.owners.some((owner) => !Array.isArray(owner.statements))) throw new Error(`${canonicalPath}: ordered runtime owners are missing`);
  return source;
}

function stableJson(value) { return `${JSON.stringify(value, null, 2)}\n`; }
function writeCanonical(snapshot, canonicalPath = CANONICAL_PATH) { fs.writeFileSync(canonicalPath, stableJson(snapshot)); }
function entriesByName(source) { return new Map(source.triggers.map((entry) => [entry.name, entry])); }
function fixedTargetSql(entry) { return entry.sql.replaceAll(`'${TOKEN}'`, FIXED_EUI); }

function jsStringExpression(sql, dynamicGateway) {
  const parts = String(sql).split(`'${TOKEN}'`);
  let expression = JSON.stringify(parts[0]);
  for (let i = 1; i < parts.length; i += 1) {
    expression += dynamicGateway ? ' + gatewaySql + ' : ` + ${JSON.stringify(`'${TOKEN}'`)} + `;
    expression += JSON.stringify(parts[i]);
  }
  return expression;
}

function generatedSyncArray(source) {
  const entries = entriesByName(source);
  const owner = source.owners.find((candidate) => candidate.nodeId === 'sync-init-fn');
  const lines = owner.statements.map((ref) => {
    if (ref.kind === 'drop') return `DROP TRIGGER IF EXISTS ${ref.name}`;
    const entry = entries.get(ref.name);
    if (!entry) throw new Error(`canonical source missing sync-init trigger ${ref.name}`);
    return entry.sql;
  });
  return ['const triggers = [', ...lines.map((sql, i) => {
    const ref = owner.statements[i];
    const expression = ref.kind === 'drop' ? JSON.stringify(sql) : jsStringExpression(sql, true);
    return `  ${expression}${i === lines.length - 1 ? '' : ','}`;
  }), '];'].join('\n');
}

function generatedDendroSql(source) {
  const owner = source.owners.find((candidate) => candidate.nodeId === 'dendro-compute-fn');
  const create = owner.statements.find((ref) => ref.kind === 'create');
  const entry = entriesByName(source).get(create && create.name);
  if (!entry) throw new Error('canonical source missing delayed dendrometer trigger');
  return entry.sql;
}

function renderSyncFunc(func, source) {
  const region = /const\s+triggers\s*=\s*\[[\s\S]*?\n\];/;
  if (!region.test(func)) throw new Error('sync-init-fn triggers array not found');
  return func.replace(region, generatedSyncArray(source));
}

function renderDendroFunc(func, source) {
  const owner = source.owners.find((candidate) => candidate.nodeId === 'dendro-compute-fn');
  const drop = owner.statements.find((ref) => ref.kind === 'drop');
  const create = owner.statements.find((ref) => ref.kind === 'create');
  if (!drop || !create) throw new Error('canonical delayed owner must contain both DROP and CREATE');
  const dropRe = new RegExp(`(?:\\x60|\\")DROP TRIGGER IF EXISTS ${drop.name}(?:\\x60|\\")`);
  const createRe = new RegExp(`(?:\\x60|\\")CREATE TRIGGER IF NOT EXISTS ${create.name}[\\s\\S]*?(?:\\x60|\\")`);
  if (!dropRe.test(func)) throw new Error('dendro-compute-fn delayed trigger DROP is missing');
  if (!createRe.test(func)) throw new Error('dendro-compute-fn delayed trigger CREATE is missing');
  const rendered = func.replace(dropRe, `\`DROP TRIGGER IF EXISTS ${drop.name}\``);
  return rendered.replace(createRe, `\`${generatedDendroSql(source).replace(/`/g, '\\`')}\``);
}

function renderProfiles(source, flowPaths = FLOW_PATHS) {
  const flows = JSON.parse(fs.readFileSync(flowPaths[0], 'utf8'));
  const sync = flows.find((entry) => entry && entry.id === 'sync-init-fn');
  const dendro = flows.find((entry) => entry && entry.id === 'dendro-compute-fn');
  if (!sync || !dendro) throw new Error('canonical profile runtime owners are missing');
  sync.func = renderSyncFunc(sync.func, source);
  dendro.func = renderDendroFunc(dendro.func, source);
  return `${JSON.stringify(flows, null, 2)}\n`;
}

function compareOwnerReferences(source, flowPath, nodeId, variable, failures) {
  const owner = source.owners.find((candidate) => candidate.nodeId === nodeId);
  const current = statementRefs(readArray(flowPath, nodeId, variable, TEST_EUI));
  if (!owner || JSON.stringify(current) !== JSON.stringify(owner.statements)) failures.push(`${flowPath}:${nodeId}: ordered DROP/CREATE statements differ`);
  const actualNames = new Set(current.filter((ref) => ref.kind === 'create').map((ref) => ref.name));
  const canonicalNames = new Set(owner.statements.filter((ref) => ref.kind === 'create').map((ref) => ref.name));
  const missing = [...actualNames].filter((name) => !canonicalNames.has(name));
  const extra = [...canonicalNames].filter((name) => !actualNames.has(name));
  if (missing.length || extra.length) failures.push(`${flowPath}:${nodeId}: trigger set differs (missing=${missing.join(',') || '-'} extra=${extra.join(',') || '-'})`);
}

function validateOwnerFixedReferences(source, flowPath, nodeId, variable) {
  const owner = source.owners.find((candidate) => candidate.nodeId === nodeId);
  if (!owner) return [`${flowPath}:${nodeId}: ordered owner is missing`];
  const canonical = entriesByName(source);
  const failures = [];
  for (const statement of readArray(flowPath, nodeId, variable, TEST_EUI)) {
    const name = triggerName(statement);
    if (!name) continue;
    const entry = canonical.get(name);
    if (!entry) {
      failures.push(`${flowPath}:${nodeId}:${name}: trigger has no canonical SQL definition`);
    } else if (canonicalSql(statement) !== canonicalSql(fixedTargetSql(entry))) {
      failures.push(`${flowPath}:${nodeId}:${name}: fixed-target SQL differs from canonical SQL`);
    }
  }
  return failures;
}

function validateFixedReferences(source, seedPath = SEED_PATH) {
  const seed = seedTriggerMap(seedPath);
  return source.triggers.filter((entry) => !seed.has(entry.name) || canonicalSql(seed.get(entry.name)) !== canonicalSql(fixedTargetSql(entry))).map((entry) => `${entry.name}: fixed-target SQL differs from seed-blank.sql`);
}

function checkCanonical(canonicalPath = CANONICAL_PATH, options = {}) {
  const source = loadCanonical(canonicalPath);
  const flowPaths = options.flowPaths || FLOW_PATHS;
  const failures = validateFixedReferences(source, options.seedPath || SEED_PATH);
  for (const flowPath of flowPaths) {
    compareOwnerReferences(source, flowPath, 'sync-init-fn', 'triggers', failures);
    compareOwnerReferences(source, flowPath, 'dendro-compute-fn', 'MIGS', failures);
    failures.push(...validateOwnerFixedReferences(source, flowPath, 'sync-init-fn', 'triggers'));
    failures.push(...validateOwnerFixedReferences(source, flowPath, 'dendro-compute-fn', 'MIGS'));
    try {
      const current = fs.readFileSync(flowPath, 'utf8');
      if (renderProfiles(source, [flowPath]) !== current) failures.push(`${flowPath}: generated trigger regions are stale`);
    } catch (error) { failures.push(`${flowPath}: ${error.message}`); }
  }
  if (failures.length) throw new Error(failures.join('\n'));
  return source;
}

function main(argv) {
  const write = argv.includes('--write');
  const check = argv.includes('--check');
  if (write === check || argv.some((arg) => !['--write', '--check'].includes(arg))) throw new Error('usage: node scripts/generate-sync-trigger-source.js (--write | --check)');
  const source = loadCanonical();
  if (write) {
    const rendered = renderProfiles(source);
    fs.writeFileSync(FLOW_PATHS[0], rendered);
    fs.writeFileSync(FLOW_PATHS[1], rendered);
    console.log(`generated ordered trigger regions in both profiles (${source.triggers.length} SQL definitions)`);
  } else {
    checkCanonical();
    console.log(`sync trigger source check passed (${source.triggers.length} SQL definitions)`);
  }
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(`generate-sync-trigger-source: FAIL - ${error.message}`); process.exit(1); }
}

module.exports = { CANONICAL_PATH, FLOW_PATHS, FIXED_EUI, TEST_EUI, TOKEN, canonicalSql, checkCanonical, fixedTargetSql, generatedDendroSql, generatedSyncArray, loadCanonical, readArray, referenceSnapshot, renderDendroFunc, renderProfiles, renderSyncFunc, stableJson, statementRefs, writeCanonical };
