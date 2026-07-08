#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SERVER_RELATIVE_SOURCE = path.join('backend', 'src', 'main', 'java', 'org', 'osi', 'server', 'sync', 'EdgeSyncService.java');
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
const SQL_SOURCES = [
  {
    name: 'seed-sql',
    path: 'database/seed-blank.sql',
  },
];
const DATABASE_SOURCES = [
  {
    name: 'db:base-bcm2709',
    path: 'conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db',
  },
  {
    name: 'db:base-bcm2712',
    path: 'conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db',
  },
  {
    name: 'db:full-bcm2708',
    path: 'conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db',
  },
  {
    name: 'db:full-bcm2709',
    path: 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db',
  },
  {
    name: 'db:full-bcm2712',
    path: 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db',
  },
  {
    name: 'db:database',
    path: 'database/farming.db',
  },
  {
    name: 'db:react-gui',
    path: 'web/react-gui/farming.db',
  },
];
const SQL_OWNED_EVENT_OPS = new Set([
  // Emitted by 0005__field_work_requests.sql / seed DB trigger, not by
  // flows.json. The server must still handle it and the schema must declare it.
  'WORK_REQUEST_SUBMITTED',
]);

function readUtf8(file) {
  return fs.readFileSync(file, 'utf8');
}

function uniquePaths(paths) {
  return [...new Set(paths)];
}

function fallbackServerSourceCandidates(root = REPO_ROOT) {
  const worktreeName = path.basename(root);
  return uniquePaths([
    path.resolve(root, '..', '..', '..', 'osi-server', '.worktrees', worktreeName, SERVER_RELATIVE_SOURCE),
    path.resolve(root, '..', 'osi-server', SERVER_RELATIVE_SOURCE),
    path.resolve(root, '..', '..', '..', 'osi-server', SERVER_RELATIVE_SOURCE),
  ]);
}

function resolveDefaultServerSource(root = REPO_ROOT) {
  const explicit = process.env.OSI_SERVER_EDGE_SYNC_SERVICE;
  if (explicit) {
    const resolved = path.isAbsolute(explicit) ? explicit : path.resolve(root, explicit);
    if (!fs.existsSync(resolved)) {
      throw new Error(`OSI_SERVER_EDGE_SYNC_SERVICE points to missing EdgeSyncService.java: ${explicit} (${resolved})`);
    }
    return resolved;
  }

  const candidates = fallbackServerSourceCandidates(root);
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
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

function findMatchingBrace(source, openIndex) {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inSingle) {
      if (ch === '\\') {
        i++;
      } else if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '\\') {
        i++;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
    } else if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function skipJavaQuotedLiteral(source, index) {
  const quote = source[index];
  if (quote === '"' && source[index + 1] === '"' && source[index + 2] === '"') {
    for (let i = index + 3; i < source.length; i++) {
      if (source[i] === '"' && source[i + 1] === '"' && source[i + 2] === '"') return i + 3;
    }
    return source.length;
  }

  for (let i = index + 1; i < source.length; i++) {
    if (source[i] === '\\') {
      i++;
    } else if (source[i] === quote) {
      return i + 1;
    }
  }
  return source.length;
}

function startsWithWord(source, index, word) {
  return source.startsWith(word, index) &&
    isWordBoundary(source, index - 1) &&
    isWordBoundary(source, index + word.length);
}

function readJavaCaseLabel(source, startIndex) {
  let depth = 0;
  let text = '';
  for (let i = startIndex; i < source.length;) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i + 2);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = skipJavaQuotedLiteral(source, i);
      text += source.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && ch === ':') {
      return { text, end: i + 1 };
    } else if (depth === 0 && ch === '-' && next === '>') {
      return { text, end: i + 2 };
    }
    text += ch;
    i++;
  }
  return null;
}

function extractJavaSwitchCaseLabels(source) {
  const labels = [];
  for (let i = 0; i < source.length;) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i + 2);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipJavaQuotedLiteral(source, i);
      continue;
    }
    if (startsWithWord(source, i, 'case')) {
      const label = readJavaCaseLabel(source, i + 'case'.length);
      if (label) {
        labels.push(label.text);
        i = label.end;
        continue;
      }
    }
    i++;
  }
  return labels;
}

function findMatchingJavaParen(source, openIndex) {
  let depth = 0;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
    } else if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
    } else if (ch === '"' || ch === "'") {
      i = skipJavaQuotedLiteral(source, i) - 1;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseJavaSwitch(source, switchIndex) {
  const selectorOpen = skipWhitespace(source, switchIndex + 'switch'.length);
  if (source[selectorOpen] !== '(') return null;
  const selectorClose = findMatchingJavaParen(source, selectorOpen);
  if (selectorClose < 0) return null;
  const selector = source.slice(selectorOpen + 1, selectorClose);
  const bodyOpen = skipWhitespace(source, selectorClose + 1);
  if (source[bodyOpen] !== '{') return null;
  const bodyClose = findMatchingBrace(source, bodyOpen);
  if (bodyClose < 0) return null;
  return {
    selector,
    body: source.slice(bodyOpen + 1, bodyClose),
    end: bodyClose + 1,
  };
}

function findJavaEventOpSwitches(source) {
  const switches = [];
  for (let i = 0; i < source.length;) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i + 2);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipJavaQuotedLiteral(source, i);
      continue;
    }
    if (startsWithWord(source, i, 'switch')) {
      const parsed = parseJavaSwitch(source, i);
      if (parsed) {
        if (/^\s*event\s*\.\s*op\s*\(\s*\)\s*$/.test(parsed.selector)) {
          switches.push(parsed);
        }
        i = parsed.end;
        continue;
      }
    }
    i++;
  }
  return switches;
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

function readTopLevelFunctionArgs(source, functionName) {
  const cursor = skipWhitespace(source, 0);
  const endName = cursor + functionName.length;
  if (
    source.slice(cursor, endName).toLowerCase() !== functionName.toLowerCase() ||
    !isWordBoundary(source, cursor - 1) ||
    !isWordBoundary(source, endName)
  ) {
    return null;
  }
  const openIndex = skipWhitespace(source, endName);
  if (source[openIndex] !== '(') return null;
  const closeIndex = findMatchingParen(source, openIndex);
  if (closeIndex < 0) return null;
  if (skipWhitespace(source, closeIndex + 1) !== source.length) return null;
  return source.slice(openIndex + 1, closeIndex);
}

function parseSqlStringLiteral(source) {
  const trimmed = source.trim();
  if (!trimmed.startsWith("'")) return null;
  let value = '';
  for (let i = 1; i < trimmed.length; i++) {
    const ch = trimmed[i];
    const next = trimmed[i + 1];
    if (ch === "'" && next === "'") {
      value += "'";
      i++;
    } else if (ch === "'") {
      return skipWhitespace(trimmed, i + 1) === trimmed.length ? value : null;
    } else {
      value += ch;
    }
  }
  return null;
}

function payloadHasTopLevelContractVersion(payloadExpression) {
  const argsSource = readTopLevelFunctionArgs(payloadExpression, 'json_object');
  if (argsSource === null) return false;
  const args = splitTopLevelComma(argsSource);
  for (let i = 0; i + 1 < args.length; i += 2) {
    if (parseSqlStringLiteral(args[i]) === 'contract_version') {
      return args[i + 1].trim() === '1';
    }
  }
  return false;
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

function indexOfInsensitive(source, needle, startIndex = 0) {
  return source.toLowerCase().indexOf(needle.toLowerCase(), startIndex);
}

function parseSyncOutboxInsert(source, index) {
  const tableIndex = indexOfInsensitive(source, 'sync_outbox', index);
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

function addOpLocation(ops, op, location) {
  if (!ops.has(op)) ops.set(op, []);
  ops.get(op).push(location);
}

function collectSyncOutboxOpsFromSource(source, locationPrefix, result) {
  if (!/sync_outbox/i.test(source)) return;

  const insertRe = /insert\s+(?:or\s+(?:abort|fail|ignore|replace|rollback)\s+)?into\s+sync_outbox\b/ig;
  let match;
  while ((match = insertRe.exec(source)) !== null) {
    const index = match.index;
    const parsed = parseSyncOutboxInsert(source, index);
    const location = `${locationPrefix}@${index}`;
    if (!parsed || parsed.error) {
      result.errors.push(`${location}: ${parsed ? parsed.error : 'unable to parse insert'}`);
      insertRe.lastIndex = index + match[0].length;
      continue;
    }

    const literals = extractQuotedConstants(parsed.opExpression);
    if (literals.length === 0) {
      result.errors.push(`${location}: op expression has no quoted op literal`);
    }
    for (const op of literals) {
      addOpLocation(result.locations, op, location);
    }
    if (!payloadHasTopLevelContractVersion(parsed.payloadExpression)) {
      result.payloadsMissingContractVersion.push(location);
    }
    insertRe.lastIndex = index + match[0].length;
  }
}

function formatOpsResult(result) {
  return {
    ops: [...result.locations.keys()].sort(),
    locations: result.locations,
    payloadsMissingContractVersion: result.payloadsMissingContractVersion,
    errors: result.errors,
  };
}

function extractFlowOps(flowPath) {
  const flows = JSON.parse(readUtf8(flowPath));
  const result = {
    locations: new Map(),
    payloadsMissingContractVersion: [],
    errors: [],
  };

  for (const node of flows) {
    const source = [node.func, node.initialize, node.finalize].filter(Boolean).join('\n');
    collectSyncOutboxOpsFromSource(source, node.name || node.id || 'unnamed node', result);
  }

  return formatOpsResult(result);
}

function extractSqlOps(sqlPath, sourceName = path.basename(sqlPath)) {
  if (!fs.existsSync(sqlPath)) {
    return { ops: [], locations: new Map(), payloadsMissingContractVersion: [], errors: [`SQL source not found at ${sqlPath}`] };
  }
  const result = {
    locations: new Map(),
    payloadsMissingContractVersion: [],
    errors: [],
  };
  collectSyncOutboxOpsFromSource(readUtf8(sqlPath), sourceName, result);
  return formatOpsResult(result);
}

function extractDatabaseOps(dbPath) {
  if (!fs.existsSync(dbPath)) {
    return { ops: [], locations: new Map(), payloadsMissingContractVersion: [], errors: [`database not found at ${dbPath}`] };
  }
  const result = {
    locations: new Map(),
    payloadsMissingContractVersion: [],
    errors: [],
  };
  let rows = [];
  try {
    const output = execFileSync('sqlite3', [
      '-readonly',
      '-json',
      dbPath,
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND lower(sql) LIKE '%sync_outbox%' ORDER BY name;",
    ], { encoding: 'utf8' }).trim();
    rows = output ? JSON.parse(output) : [];
  } catch (error) {
    result.errors.push(`unable to read sync_outbox triggers from ${dbPath}: ${error.message}`);
  }
  for (const row of rows) {
    collectSyncOutboxOpsFromSource(String(row.sql || ''), row.name || 'unnamed trigger', result);
  }
  return formatOpsResult(result);
}

function extractSchemaOps(schemaPath) {
  const schema = JSON.parse(readUtf8(schemaPath));
  const ops = schema.properties && schema.properties.op && Array.isArray(schema.properties.op.enum)
    ? schema.properties.op.enum
    : [];
  const errors = [];
  if (ops.length === 0) errors.push('events.schema.json properties.op.enum is missing or empty');
  const payload = schema.properties && schema.properties.payload;
  const payloadRequired = payload && Array.isArray(payload.required) ? payload.required : [];
  const contractVersion = payload && payload.properties && payload.properties.contract_version;
  if (!payload) {
    errors.push('events.schema.json properties.payload is missing');
  } else if (!payloadRequired.includes('contract_version')) {
    errors.push('events.schema.json payload.required must include contract_version');
  }
  if (!contractVersion) {
    errors.push('events.schema.json properties.payload.properties.contract_version is missing');
  } else if (contractVersion.type !== 'integer') {
    errors.push('events.schema.json payload contract_version must be an integer');
  } else if (contractVersion.const !== 1) {
    errors.push('events.schema.json payload contract_version const must be 1');
  }
  return { ops: [...new Set(ops)].sort(), errors };
}

function extractServerOps(serverSource) {
  if (!fs.existsSync(serverSource)) {
    return { ops: [], errors: [`EdgeSyncService.java not found at ${serverSource}`] };
  }
  const source = readUtf8(serverSource);
  const switches = findJavaEventOpSwitches(source);
  if (switches.length === 0) {
    return { ops: [], errors: ['EdgeSyncService canonical switch(event.op()) not found'] };
  }
  if (switches.length > 1) {
    return { ops: [], errors: [`EdgeSyncService must have exactly one switch(event.op()); found ${switches.length}`] };
  }
  const switchBody = switches[0].body;
  const ops = [];
  for (const label of extractJavaSwitchCaseLabels(switchBody)) {
    ops.push(...extractQuotedConstants(label));
  }
  return { ops: [...new Set(ops)].sort(), errors: [] };
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
  const serverSource = options.serverSource || resolveDefaultServerSource(root);
  const flowSources = options.flowSources === undefined ? FLOW_SOURCES : options.flowSources;
  const sqlSources = options.sqlSources === undefined ? SQL_SOURCES : options.sqlSources;
  const databaseSources = options.databaseSources === undefined ? DATABASE_SOURCES : options.databaseSources;
  const sourcePath = (entry) => path.resolve(root, entry.path);

  const flowResults = flowSources.map((flow) => ({
    name: `flows:${flow.name}`,
    path: sourcePath(flow),
    checkOps: true,
    ...extractFlowOps(sourcePath(flow)),
  }));
  const sqlResults = sqlSources.map((source) => ({
    name: source.name,
    path: sourcePath(source),
    checkOps: 'subset',
    ...extractSqlOps(sourcePath(source), source.name),
  }));
  const databaseResults = databaseSources.map((source) => ({
    name: source.name,
    path: sourcePath(source),
    checkOps: 'subset',
    ...extractDatabaseOps(sourcePath(source)),
  }));
  const schemaResult = {
    name: 'schema',
    path: schemaPath,
    checkOps: true,
    ...extractSchemaOps(schemaPath),
  };
  const serverResult = {
    name: 'server',
    path: serverSource,
    checkOps: true,
    ...extractServerOps(serverSource),
  };
  const sources = [...flowResults, ...sqlResults, ...databaseResults, schemaResult, serverResult];
  const canonicalSources = sources.filter((source) => source.checkOps === true);
  const subsetSources = sources.filter((source) => source.checkOps === 'subset');
  const allOps = [...new Set(canonicalSources.flatMap((source) => source.ops))].sort();
  const canonicalOps = new Set(allOps);
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

  for (const source of canonicalSources) {
    const isFlowSource = source.name.startsWith('flows:');
    const expectedOps = isFlowSource
      ? allOps.filter((op) => !SQL_OWNED_EVENT_OPS.has(op))
      : allOps;
    const baselineName = isFlowSource ? 'flow-required union' : 'union';
    const diff = diffSets(expectedOps, source.ops);
    const diffLines = formatDiff(source.name, baselineName, diff);
    if (diffLines.length) {
      ok = false;
      lines.push(...diffLines);
    }
  }

  for (const source of subsetSources) {
    const extras = source.ops.filter((op) => !canonicalOps.has(op));
    if (extras.length) {
      ok = false;
      lines.push(`  ${source.name} extra vs union: ${extras.join(', ')}`);
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
  const serverSource = process.argv[2]
    ? (path.isAbsolute(process.argv[2]) ? process.argv[2] : path.resolve(process.cwd(), process.argv[2]))
    : resolveDefaultServerSource(REPO_ROOT);
  const result = checkSyncOpParity({ serverSource });
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
  extractDatabaseOps,
  extractFlowOps,
  extractSchemaOps,
  extractServerOps,
  extractSqlOps,
  payloadHasTopLevelContractVersion,
  resolveDefaultServerSource,
};
