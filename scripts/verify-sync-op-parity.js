#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SERVER_SOURCE_CANDIDATES = [
  process.env.OSI_SERVER_EDGE_SYNC_SERVICE,
  '/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java',
  '/home/phil/Repos/osi-server/.worktrees/sync-contract-tranche-a/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java',
].filter(Boolean);
const DEFAULT_SERVER_SOURCE = SERVER_SOURCE_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ||
  SERVER_SOURCE_CANDIDATES[0];
const FLOW_SOURCES = [
  {
    name: 'bcm2712',
    path: 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  },
  {
    name: 'bcm2709',
    path: 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
  },
];

function readUtf8(file) {
  return fs.readFileSync(file, 'utf8');
}

function skipWhitespace(source, index) {
  while (index < source.length && /\s/.test(source[index])) index++;
  return index;
}

function findMatchingParen(source, openIndex) {
  let depth = 0;
  let inSingle = false;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (inSingle) {
      if (ch === "'" && next === "'") {
        i++;
      } else if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevelComma(source) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let inSingle = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (inSingle) {
      if (ch === "'" && next === "'") {
        i++;
      } else if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    } else if (ch === ',' && depth === 0) {
      parts.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts;
}

function isWordBoundary(source, index) {
  return index < 0 || index >= source.length || !/[A-Za-z0-9_]/.test(source[index]);
}

function findTopLevelKeyword(source, keyword, startIndex) {
  const upper = source.toUpperCase();
  const target = keyword.toUpperCase();
  let depth = 0;
  let inSingle = false;
  for (let i = startIndex; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (inSingle) {
      if (ch === "'" && next === "'") {
        i++;
      } else if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
    } else if (
      depth === 0 &&
      upper.startsWith(target, i) &&
      isWordBoundary(source, i - 1) &&
      isWordBoundary(source, i + target.length)
    ) {
      return i;
    }
  }
  return -1;
}

function extractQuotedConstants(source) {
  const values = [];
  const re = /['"]([A-Z][A-Z0-9_]+)['"]/g;
  let match;
  while ((match = re.exec(source)) !== null) values.push(match[1]);
  return values;
}

function parseSyncOutboxInsert(source, index) {
  const tableIndex = source.indexOf('sync_outbox', index);
  if (tableIndex < 0) return null;
  const colsOpen = source.indexOf('(', tableIndex);
  if (colsOpen < 0) return null;
  const colsClose = findMatchingParen(source, colsOpen);
  if (colsClose < 0) return null;

  const columns = splitTopLevelComma(source.slice(colsOpen + 1, colsClose))
    .map((c) => c.trim().toLowerCase());
  const opIndex = columns.indexOf('op');
  const payloadIndex = columns.indexOf('payload_json');
  if (opIndex < 0 || payloadIndex < 0) {
    return { error: 'sync_outbox insert missing op or payload_json column' };
  }

  let cursor = skipWhitespace(source, colsClose + 1);
  const upper = source.toUpperCase();
  let expressions = null;
  if (upper.startsWith('VALUES', cursor)) {
    cursor = skipWhitespace(source, cursor + 'VALUES'.length);
    if (source[cursor] !== '(') return { error: 'VALUES insert missing value list' };
    const valuesClose = findMatchingParen(source, cursor);
    if (valuesClose < 0) return { error: 'VALUES insert has unbalanced value list' };
    expressions = splitTopLevelComma(source.slice(cursor + 1, valuesClose));
  } else if (upper.startsWith('SELECT', cursor)) {
    const selectStart = cursor + 'SELECT'.length;
    const fromIndex = findTopLevelKeyword(source, 'FROM', selectStart);
    if (fromIndex < 0) return { error: 'SELECT insert missing top-level FROM' };
    expressions = splitTopLevelComma(source.slice(selectStart, fromIndex));
  } else {
    return { error: 'sync_outbox insert is neither VALUES nor SELECT' };
  }

  if (opIndex >= expressions.length || payloadIndex >= expressions.length) {
    return { error: 'sync_outbox insert has fewer expressions than columns' };
  }

  return {
    opExpression: expressions[opIndex],
    payloadExpression: expressions[payloadIndex],
  };
}

function extractFlowOps(flowPath) {
  const flows = JSON.parse(readUtf8(flowPath));
  const ops = new Map();
  const payloadsMissingContractVersion = [];
  const errors = [];

  for (const node of flows) {
    const source = [node.func, node.initialize, node.finalize].filter(Boolean).join('\n');
    if (!source.includes('sync_outbox')) continue;

    let index = 0;
    while ((index = source.indexOf('INSERT INTO sync_outbox', index)) >= 0) {
      const parsed = parseSyncOutboxInsert(source, index);
      const location = `${node.name || node.id || 'unnamed node'}@${index}`;
      if (!parsed || parsed.error) {
        errors.push(`${location}: ${parsed ? parsed.error : 'unable to parse insert'}`);
        index += 'INSERT INTO sync_outbox'.length;
        continue;
      }

      const literals = extractQuotedConstants(parsed.opExpression);
      if (literals.length === 0) {
        errors.push(`${location}: op expression has no quoted op literal`);
      }
      for (const op of literals) {
        if (!ops.has(op)) ops.set(op, []);
        ops.get(op).push(location);
      }
      if (!/'contract_version'\s*,\s*1\b/.test(parsed.payloadExpression)) {
        payloadsMissingContractVersion.push(location);
      }
      index += 'INSERT INTO sync_outbox'.length;
    }
  }

  return {
    ops: [...ops.keys()].sort(),
    locations: ops,
    payloadsMissingContractVersion,
    errors,
  };
}

function extractSchemaOps(schemaPath) {
  const schema = JSON.parse(readUtf8(schemaPath));
  const ops = schema.properties && schema.properties.op && Array.isArray(schema.properties.op.enum)
    ? schema.properties.op.enum
    : [];
  const errors = [];
  if (ops.length === 0) errors.push('events.schema.json properties.op.enum is missing or empty');
  const contractVersion = schema.properties && schema.properties.contract_version;
  if (!contractVersion) {
    errors.push('events.schema.json properties.contract_version is missing');
  } else if (contractVersion.type !== 'integer') {
    errors.push('events.schema.json contract_version must be an integer');
  }
  return { ops: [...new Set(ops)].sort(), errors };
}

function extractServerOps(serverSource) {
  if (!fs.existsSync(serverSource)) {
    return { ops: [], errors: [`EdgeSyncService.java not found at ${serverSource}`] };
  }
  const source = readUtf8(serverSource);
  const start = source.indexOf('private void applyEvent(String gatewayDeviceEui, SyncEventRecord event)');
  if (start < 0) {
    return { ops: [], errors: ['EdgeSyncService.applyEvent method not found'] };
  }
  const end = source.indexOf('\n    private void recordOutboxMirror', start);
  if (end < 0) {
    return { ops: [], errors: ['EdgeSyncService.applyEvent end marker not found'] };
  }
  return { ops: [...new Set(extractQuotedConstants(source.slice(start, end)))].sort(), errors: [] };
}

function diffSets(expected, actual) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  return {
    missing: expected.filter((op) => !actualSet.has(op)),
    extra: actual.filter((op) => !expectedSet.has(op)),
  };
}

function formatSet(name, ops) {
  return `${name} (${ops.length}): ${ops.join(', ') || '(none)'}`;
}

function formatDiff(name, baselineName, diff) {
  const lines = [];
  if (diff.missing.length) lines.push(`  ${name} missing from ${baselineName}: ${diff.missing.join(', ')}`);
  if (diff.extra.length) lines.push(`  ${name} extra vs ${baselineName}: ${diff.extra.join(', ')}`);
  return lines;
}

function checkSyncOpParity(options = {}) {
  const root = path.resolve(options.root || REPO_ROOT);
  const schemaPath = options.schemaPath || path.join(root, 'docs/contracts/sync-schema/events.schema.json');
  const serverSource = options.serverSource || DEFAULT_SERVER_SOURCE;

  const flowResults = FLOW_SOURCES.map((flow) => ({
    name: `flows:${flow.name}`,
    path: path.join(root, flow.path),
    ...extractFlowOps(path.join(root, flow.path)),
  }));
  const schemaResult = {
    name: 'schema',
    path: schemaPath,
    ...extractSchemaOps(schemaPath),
  };
  const serverResult = {
    name: 'server',
    path: serverSource,
    ...extractServerOps(serverSource),
  };
  const sources = [...flowResults, schemaResult, serverResult];
  const allOps = [...new Set(sources.flatMap((source) => source.ops))].sort();
  const lines = [];
  let ok = true;

  for (const source of sources) {
    lines.push(formatSet(source.name, source.ops));
    for (const error of source.errors || []) {
      ok = false;
      lines.push(`  ERROR ${source.name}: ${error}`);
    }
    if (source.payloadsMissingContractVersion && source.payloadsMissingContractVersion.length) {
      ok = false;
      lines.push(`  ERROR ${source.name}: payload_json missing contract_version in ${source.payloadsMissingContractVersion.length} sync_outbox insert(s)`);
      for (const location of source.payloadsMissingContractVersion) lines.push(`    - ${location}`);
    }
  }

  for (const source of sources) {
    const diff = diffSets(allOps, source.ops);
    const diffLines = formatDiff(source.name, 'union', diff);
    if (diffLines.length) {
      ok = false;
      lines.push(...diffLines);
    }
  }

  return {
    ok,
    sources,
    union: allOps,
    message: lines.join('\n'),
  };
}

function main() {
  const result = checkSyncOpParity({ serverSource: process.argv[2] || DEFAULT_SERVER_SOURCE });
  console.log(result.message);
  if (!result.ok) {
    console.error('verify-sync-op-parity: FAIL');
    process.exit(1);
  }
  console.log('verify-sync-op-parity: OK');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('verify-sync-op-parity: FAIL');
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  }
}

module.exports = {
  checkSyncOpParity,
  extractFlowOps,
  extractSchemaOps,
  extractServerOps,
};
