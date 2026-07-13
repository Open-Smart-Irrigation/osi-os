#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SERVER_RELATIVE_SOURCE = path.join('backend', 'src', 'main', 'java', 'org', 'osi', 'server', 'sync', 'EdgeSyncService.java');
const STAGING_MANIFEST_RELATIVE = 'scripts/fixtures/sync-contract-staging.json';
const JOURNAL_MODULE_DIRECTORY =
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal';
const AUDITED_JOURNAL_OUTBOX_EMITTER = {
  file: 'lifecycle.js',
  functionName: 'emitJournalOutbox',
};
const EXACT_STAGED_COMMANDS = [
  'UPSERT_JOURNAL_ENTRY',
  'VOID_JOURNAL_ENTRY',
  'UPSERT_JOURNAL_CUSTOM_VOCAB',
  'UPSERT_JOURNAL_PLOT',
  'UPSERT_JOURNAL_PLOT_GROUP',
];
const EXACT_EDGE_DEFERRED_COMMANDS = [];
const EXACT_EDGE_MODULE_OPS = [
  'JOURNAL_ENTRY_UPSERTED',
  'JOURNAL_ENTRY_VOIDED',
  'JOURNAL_VOCAB_UPSERTED',
  'JOURNAL_PLOT_UPSERTED',
  'JOURNAL_PLOT_GROUP_UPSERTED',
];
const EXACT_EDGE_DEFERRED_OPS = [];
const EXACT_JOURNAL_EVENT_OPS = [
  ...EXACT_EDGE_MODULE_OPS,
  ...EXACT_EDGE_DEFERRED_OPS,
];
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
    path.resolve(root, '..', '..', '..', '..', 'osi-server', '.worktrees', worktreeName, SERVER_RELATIVE_SOURCE),
    path.resolve(root, '..', '..', '..', '..', 'osi-server', SERVER_RELATIVE_SOURCE),
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

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function sameKeys(actual, expected) {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function validateStagingManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['staging manifest must be an object'];
  }
  const rootKeys = Object.keys(manifest).sort();
  if (!sameKeys(rootKeys, ['commands', 'eventOps', 'version'])) {
    errors.push(`staging root keys must be commands,eventOps,version; got ${rootKeys.join(',') || '(none)'}`);
  }
  if (manifest.version !== 1) errors.push(`staging version must be 1; got ${String(manifest.version)}`);

  const commands = manifest.commands;
  const commandKeys = commands && typeof commands === 'object' && !Array.isArray(commands)
    ? Object.keys(commands).sort()
    : [];
  if (!sameKeys(commandKeys, ['cloudDeferred', 'edgeDeferred'])) {
    errors.push(`staging commands keys must be cloudDeferred,edgeDeferred; got ${commandKeys.join(',') || '(none)'}`);
  }

  const eventOps = manifest.eventOps;
  const eventKeys = eventOps && typeof eventOps === 'object' && !Array.isArray(eventOps)
    ? Object.keys(eventOps).sort()
    : [];
  if (!sameKeys(eventKeys, ['cloudDeferred', 'edgeDeferred', 'edgeModuleOwned'])) {
    errors.push(`staging eventOps keys must be cloudDeferred,edgeDeferred,edgeModuleOwned; got ${eventKeys.join(',') || '(none)'}`);
  }

  const checks = [
    ['commands.edgeDeferred', commands && commands.edgeDeferred, EXACT_EDGE_DEFERRED_COMMANDS],
    ['commands.cloudDeferred', commands && commands.cloudDeferred, EXACT_STAGED_COMMANDS],
    ['eventOps.edgeModuleOwned', eventOps && eventOps.edgeModuleOwned, EXACT_EDGE_MODULE_OPS],
    ['eventOps.edgeDeferred', eventOps && eventOps.edgeDeferred, EXACT_EDGE_DEFERRED_OPS],
    ['eventOps.cloudDeferred', eventOps && eventOps.cloudDeferred, EXACT_JOURNAL_EVENT_OPS],
  ];
  for (const [name, actual, expected] of checks) {
    if (!Array.isArray(actual)) {
      errors.push(`staging ${name} must be an array`);
      continue;
    }
    const diff = diffSets(expected, actual);
    const duplicates = actual.filter((value, index) => actual.indexOf(value) !== index);
    if (diff.missing.length || diff.extra.length || duplicates.length) {
      const details = [];
      if (diff.missing.length) details.push(`missing ${diff.missing.join(', ')}`);
      if (diff.extra.length) details.push(`extra ${diff.extra.join(', ')}`);
      if (duplicates.length) details.push(`duplicates ${sortedUnique(duplicates).join(', ')}`);
      errors.push(`staging ${name} must be the exact closed set: ${details.join('; ')}`);
    }
  }

  if (eventOps && Array.isArray(eventOps.edgeModuleOwned) && Array.isArray(eventOps.edgeDeferred)) {
    const edgeUnion = sortedUnique(eventOps.edgeModuleOwned.concat(eventOps.edgeDeferred));
    const edgeDiff = diffSets(sortedUnique(EXACT_JOURNAL_EVENT_OPS), edgeUnion);
    if (edgeDiff.missing.length || edgeDiff.extra.length) {
      errors.push('staging edgeModuleOwned union edgeDeferred must equal the exact journal event-op set');
    }
  }
  return errors;
}

function loadStagingManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    return { manifest: null, errors: [`staging manifest not found at ${manifestPath}`] };
  }
  try {
    const manifest = JSON.parse(readUtf8(manifestPath));
    return { manifest, errors: validateStagingManifest(manifest) };
  } catch (error) {
    return { manifest: null, errors: [`unable to parse staging manifest at ${manifestPath}: ${error.message}`] };
  }
}

function discoverJournalModuleSources(root) {
  const directory = path.join(root, JOURNAL_MODULE_DIRECTORY);
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    return {
      sources: [],
      errors: [`unable to list production journal modules in ${directory}: ${error.message}`],
    };
  }
  const sources = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.test.js'))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({
      name: entry.name.slice(0, -'.js'.length),
      path: path.join(directory, entry.name),
    }));
  if (sources.length === 0) {
    return { sources, errors: [`no production journal modules found in ${directory}`] };
  }
  return { sources, errors: [] };
}

function stripJavaScriptComments(source) {
  const output = source.split('');
  let state = 'code';
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    const next = source[index + 1];
    if (state === 'line-comment') {
      if (ch === '\n') {
        state = 'code';
      } else {
        output[index] = ' ';
      }
      continue;
    }
    if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        output[index] = ' ';
        output[index + 1] = ' ';
        index += 1;
        state = 'code';
      } else if (ch !== '\n' && ch !== '\r') {
        output[index] = ' ';
      }
      continue;
    }
    if (state !== 'code') {
      if (ch === '\\') {
        index += 1;
      } else if ((state === 'single' && ch === "'") ||
        (state === 'double' && ch === '"') ||
        (state === 'template' && ch === '`')) {
        state = 'code';
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      output[index] = ' ';
      output[index + 1] = ' ';
      index += 1;
      state = 'line-comment';
    } else if (ch === '/' && next === '*') {
      output[index] = ' ';
      output[index + 1] = ' ';
      index += 1;
      state = 'block-comment';
    } else if (ch === "'") {
      state = 'single';
    } else if (ch === '"') {
      state = 'double';
    } else if (ch === '`') {
      state = 'template';
    }
  }
  return output.join('');
}

function maskJavaScriptStrings(source) {
  const output = source.split('');
  let state = 'code';
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    if (state === 'code') {
      if (ch === "'") state = 'single';
      else if (ch === '"') state = 'double';
      else if (ch === '`') state = 'template';
      if (state !== 'code') output[index] = ' ';
      continue;
    }
    if (ch !== '\n' && ch !== '\r') output[index] = ' ';
    if (ch === '\\') {
      if (index + 1 < output.length && source[index + 1] !== '\n') output[index + 1] = ' ';
      index += 1;
    } else if ((state === 'single' && ch === "'") ||
      (state === 'double' && ch === '"') ||
      (state === 'template' && ch === '`')) {
      state = 'code';
    }
  }
  return output.join('');
}

function findMatchingJavaScriptParen(maskedSource, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < maskedSource.length; index += 1) {
    if (maskedSource[index] === '(') depth += 1;
    if (maskedSource[index] === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findMatchingJavaScriptBrace(maskedSource, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < maskedSource.length; index += 1) {
    if (maskedSource[index] === '{') depth += 1;
    if (maskedSource[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function isOutboxFunctionDefinition(maskedSource, calleeIndex, closeIndex) {
  const prefix = maskedSource.slice(Math.max(0, calleeIndex - 80), calleeIndex);
  if (/\bfunction\s*\*?\s*$/.test(prefix)) return true;
  const suffix = maskedSource.slice(closeIndex + 1).trimStart();
  return suffix.startsWith('=>') || suffix.startsWith('{');
}

function extractJavaScriptStringLiterals(source) {
  const literals = [];
  for (let index = 0; index < source.length; index += 1) {
    const quote = source[index];
    if (quote !== "'" && quote !== '"' && quote !== '`') continue;
    const start = index;
    let value = '';
    let closed = false;
    let dynamicTemplate = false;
    for (index += 1; index < source.length; index += 1) {
      const ch = source[index];
      if (ch === '\\') {
        value += ch;
        if (index + 1 < source.length) value += source[index += 1];
      } else if (ch === quote) {
        closed = true;
        break;
      } else {
        if (quote === '`' && ch === '$' && source[index + 1] === '{') dynamicTemplate = true;
        value += ch;
      }
    }
    if (closed) literals.push({ start, end: index, value, dynamicTemplate });
  }
  return literals;
}

function extractJournalOperationLiterals(source) {
  const journalOperation = /^JOURNAL_[A-Z0-9_]+_(?:UPSERTED|VOIDED)$/;
  return extractJavaScriptStringLiterals(source)
    .filter((literal) => !literal.dynamicTemplate && journalOperation.test(literal.value))
    .map((literal) => literal.value);
}

function extractJournalOperationTokens(source) {
  const operations = [];
  const journalOperation = /\bJOURNAL_[A-Z0-9_]+_(?:UPSERTED|VOIDED)\b/g;
  let match;
  while ((match = journalOperation.exec(source)) !== null) operations.push(match[0]);
  return operations;
}

function directSyncOutboxSqlSites(source) {
  const insert = /\binsert\s+(?:or\s+(?:abort|fail|ignore|replace|rollback)\s+)?into\s+sync_outbox\b/i;
  const literals = extractJavaScriptStringLiterals(source);
  const sites = [];
  for (let index = 0; index < literals.length; index += 1) {
    const first = literals[index];
    let last = first;
    let sql = first.value;
    while (index + 1 < literals.length &&
      /^\s*\+\s*$/.test(source.slice(last.end + 1, literals[index + 1].start))) {
      last = literals[index += 1];
      sql += last.value;
    }
    if (insert.test(sql)) sites.push({ start: first.start, end: last.end, sql });
  }
  return sites;
}

function auditedJournalOutboxEmitterRange(modulePath, maskedSource) {
  if (path.basename(modulePath) !== AUDITED_JOURNAL_OUTBOX_EMITTER.file) return null;
  const definition = new RegExp(
    '\\b(?:async\\s+)?function\\s+' + AUDITED_JOURNAL_OUTBOX_EMITTER.functionName +
      '\\s*\\([^)]*\\)\\s*\\{',
    'g'
  );
  const matches = [...maskedSource.matchAll(definition)];
  if (matches.length !== 1) return null;
  const openIndex = matches[0].index + matches[0][0].lastIndexOf('{');
  const closeIndex = findMatchingJavaScriptBrace(maskedSource, openIndex);
  return closeIndex < 0 ? null : { start: openIndex, end: closeIndex };
}

function extractJournalModuleOps(modulePath) {
  if (!fs.existsSync(modulePath)) {
    return { ops: [], errors: [`journal module source not found at ${modulePath}`] };
  }
  const source = stripJavaScriptComments(readUtf8(modulePath));
  const maskedSource = maskJavaScriptStrings(source);
  const ops = extractJournalOperationLiterals(source);
  const errors = [];
  let match;

  const directSqlSites = directSyncOutboxSqlSites(source);
  const auditedEmitter = auditedJournalOutboxEmitterRange(modulePath, maskedSource);
  let auditedSiteCount = 0;
  for (const site of directSqlSites) {
    ops.push(...extractJournalOperationTokens(site.sql));
    const isAudited = auditedEmitter && site.start > auditedEmitter.start && site.end < auditedEmitter.end;
    if (isAudited) {
      auditedSiteCount += 1;
      continue;
    }
    errors.push(
      `${path.basename(modulePath)}@${site.start}: direct sync_outbox SQL is forbidden outside ` +
      `${AUDITED_JOURNAL_OUTBOX_EMITTER.file} ${AUDITED_JOURNAL_OUTBOX_EMITTER.functionName}()`
    );
  }
  if (path.basename(modulePath) === AUDITED_JOURNAL_OUTBOX_EMITTER.file && auditedSiteCount !== 1) {
    errors.push(
      `${AUDITED_JOURNAL_OUTBOX_EMITTER.file}: ${AUDITED_JOURNAL_OUTBOX_EMITTER.functionName}() ` +
      `must contain exactly one audited sync_outbox insert; found ${auditedSiteCount}`
    );
  }

  const call = /\b([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/g;
  while ((match = call.exec(maskedSource)) !== null) {
    const callee = match[1].replace(/\s+/g, '');
    if (!callee.toLowerCase().includes('outbox')) continue;
    const openIndex = match.index + match[0].lastIndexOf('(');
    const closeIndex = findMatchingJavaScriptParen(maskedSource, openIndex);
    const location = `${path.basename(modulePath)}@${match.index}`;
    if (closeIndex < 0) {
      errors.push(`${location}: unparseable outbox call; missing closing parenthesis`);
      break;
    }
    if (!isOutboxFunctionDefinition(maskedSource, match.index, closeIndex)) {
      const argumentsSource = source.slice(openIndex + 1, closeIndex);
      if (extractJournalOperationLiterals(argumentsSource).length === 0) {
        errors.push(`${location}: dynamic outbox operation; journal outbox calls must include a literal JOURNAL_* operation`);
      }
    }
    call.lastIndex = closeIndex + 1;
  }
  return { ops: sortedUnique(ops), errors };
}

function extractSyncEventApplierOps(serverSource) {
  const directory = path.dirname(serverSource);
  const ops = [];
  const errors = [];
  let names;
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith('.java'));
  } catch (error) {
    return { ops, errors: [`unable to list SyncEventApplier sources in ${directory}: ${error.message}`] };
  }
  for (const name of names) {
    const file = path.join(directory, name);
    const source = readUtf8(file);
    if (!/\bimplements\s+SyncEventApplier\b/.test(source)) continue;
    const method = /\bsupportedOps\s*\(\s*\)\s*\{/.exec(source);
    if (!method) {
      errors.push(`${name} implements SyncEventApplier without a supportedOps() body`);
      continue;
    }
    const bodyOpen = method.index + method[0].lastIndexOf('{');
    const bodyClose = findMatchingBrace(source, bodyOpen);
    if (bodyClose < 0) {
      errors.push(`${name} has an unbalanced supportedOps() body`);
      continue;
    }
    const body = source.slice(bodyOpen + 1, bodyClose);
    const returnedSet = /\breturn\s+Set\s*\.\s*of\s*\(([\s\S]*?)\)\s*;/.exec(body);
    if (!returnedSet) {
      errors.push(`${name} supportedOps() must return a literal Set.of(...) for parity extraction`);
      continue;
    }
    const declared = extractQuotedConstants(returnedSet[1]);
    if (declared.length === 0) {
      errors.push(`${name} supportedOps() Set.of(...) contains no literal operation`);
      continue;
    }
    ops.push(...declared);
  }
  return { ops: sortedUnique(ops), errors };
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
  const applierResult = extractSyncEventApplierOps(serverSource);
  ops.push(...applierResult.ops);
  return { ops: sortedUnique(ops), errors: applierResult.errors };
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
  const sqlOwnedEventOps = options.sqlOwnedEventOps === undefined
    ? SQL_OWNED_EVENT_OPS
    : new Set(options.sqlOwnedEventOps);
  const requireSqlOwnedSources = options.requireSqlOwnedSources === undefined
    ? options.sqlSources === undefined && options.databaseSources === undefined
    : Boolean(options.requireSqlOwnedSources);
  const stagingEnabled = options.stagingManifest !== false;
  const discoveredModules = options.moduleSources === undefined && stagingEnabled
    ? discoverJournalModuleSources(root)
    : { sources: [], errors: [] };
  const moduleSources = options.moduleSources === undefined
    ? discoveredModules.sources
    : options.moduleSources;
  const sourcePath = (entry) => path.resolve(root, entry.path);

  let stagingErrors = [];
  if (stagingEnabled) {
    if (options.stagingManifest !== undefined) {
      stagingErrors = validateStagingManifest(options.stagingManifest);
    } else {
      const manifestPath = options.stagingManifestPath || path.join(root, STAGING_MANIFEST_RELATIVE);
      stagingErrors = loadStagingManifest(manifestPath).errors;
    }
  }
  stagingErrors.push(...discoveredModules.errors);
  // The fixture is evidence of staging state, not an extensible allow list. The
  // executable policy remains pinned to these reviewed closed sets.
  const staging = stagingEnabled ? {
    edgeModuleOwned: EXACT_EDGE_MODULE_OPS,
    edgeDeferred: EXACT_EDGE_DEFERRED_OPS,
    cloudDeferred: EXACT_JOURNAL_EVENT_OPS,
  } : {
    edgeModuleOwned: [],
    edgeDeferred: [],
    cloudDeferred: [],
  };

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
  const moduleResults = moduleSources.map((source) => ({
    name: `module:${source.name}`,
    path: sourcePath(source),
    checkOps: 'module',
    ...extractJournalModuleOps(sourcePath(source)),
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
  const sources = [...flowResults, ...sqlResults, ...databaseResults, ...moduleResults, schemaResult, serverResult];
  const lines = [];
  let ok = true;

  for (const error of stagingErrors) {
    ok = false;
    lines.push(`  ERROR staging: ${error}`);
  }

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

  const flowUnion = sortedUnique(flowResults.flatMap((source) => source.ops));
  for (const source of flowResults) {
    const diffLines = formatDiff(source.name, 'flow union', diffSets(flowUnion, source.ops));
    if (diffLines.length) {
      ok = false;
      lines.push(...diffLines);
    }
  }

  const moduleUnion = sortedUnique(moduleResults.flatMap((source) => source.ops));
  if (stagingEnabled) {
    const moduleDiff = diffSets(staging.edgeModuleOwned, moduleUnion);
    if (moduleDiff.missing.length) {
      ok = false;
      lines.push(`  edgeModuleOwned missing from module sources: ${moduleDiff.missing.join(', ')}`);
    }
    if (moduleDiff.extra.length) {
      ok = false;
      lines.push(`  module sources contain undeclared journal ops: ${moduleDiff.extra.join(', ')}`);
    }
  }

  const nonModuleRuntimeOps = sortedUnique([
    ...flowResults.flatMap((source) => source.ops),
    ...sqlResults.flatMap((source) => source.ops),
    ...databaseResults.flatMap((source) => source.ops),
    ...(stagingEnabled ? sqlOwnedEventOps : []),
  ]);
  if (requireSqlOwnedSources) {
    const persistenceOps = new Set([
      ...sqlResults.flatMap((source) => source.ops),
      ...databaseResults.flatMap((source) => source.ops),
    ]);
    const missingSqlOwned = [...sqlOwnedEventOps].filter((op) => !persistenceOps.has(op));
    if (missingSqlOwned.length) {
      ok = false;
      lines.push(`  SQL-owned ops missing from persistence sources: ${missingSqlOwned.join(', ')}`);
    }
  }
  if (stagingEnabled) {
    const misplacedOwned = nonModuleRuntimeOps.filter((op) => staging.edgeModuleOwned.includes(op));
    if (misplacedOwned.length) {
      ok = false;
      lines.push(`  edgeModuleOwned ops also appear outside module sources: ${misplacedOwned.join(', ')}`);
    }
  }

  const deployedEdgeOps = sortedUnique(nonModuleRuntimeOps.concat(moduleUnion));
  const deployedDeferred = deployedEdgeOps.filter((op) => staging.edgeDeferred.includes(op));
  if (deployedDeferred.length) {
    ok = false;
    lines.push(`  edgeDeferred ops already appear in deployed edge sources: ${deployedDeferred.join(', ')}`);
  }

  const expectedSchemaOps = sortedUnique(deployedEdgeOps.concat(staging.edgeDeferred));
  const schemaDiffLines = formatDiff('schema', 'deployed edge plus staged union', diffSets(expectedSchemaOps, schemaResult.ops));
  if (schemaDiffLines.length) {
    ok = false;
    lines.push(...schemaDiffLines);
  }

  const expectedServerOps = expectedSchemaOps.filter((op) => !staging.cloudDeferred.includes(op));
  const serverDiffLines = formatDiff('server', 'union', diffSets(expectedServerOps, serverResult.ops));
  if (serverDiffLines.length) {
    ok = false;
    lines.push(...serverDiffLines);
  }

  return {
    ok,
    sources,
    union: expectedSchemaOps,
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
