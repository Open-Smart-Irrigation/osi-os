'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repoRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(repoRoot, 'web', 'react-gui', 'src', 'channels', 'channels.json');
const helperPaths = [
  path.join(
    repoRoot,
    'conf',
    'full_raspberrypi_bcm27xx_bcm2712',
    'files',
    'usr',
    'share',
    'node-red',
    'osi-history-helper',
    'index.js'
  ),
  path.join(
    repoRoot,
    'conf',
    'full_raspberrypi_bcm27xx_bcm2709',
    'files',
    'usr',
    'share',
    'node-red',
    'osi-history-helper',
    'index.js'
  ),
];

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function loadManifestContract() {
  const manifest = JSON.parse(readText(manifestPath));
  if (!Array.isArray(manifest)) {
    throw new Error(`expected manifest array in ${path.relative(repoRoot, manifestPath)}`);
  }

  const allowed = new Set();
  const exportable = new Set();
  const aliases = {};
  for (const entry of manifest) {
    if (!entry || typeof entry.key !== 'string' || !entry.key.trim()) {
      throw new Error('manifest entry is missing a non-empty key');
    }
    allowed.add(entry.key);
    if (entry.exportable === true && entry.deprecated !== true) {
      exportable.add(entry.key);
    }
    for (const alias of Array.isArray(entry.legacyAliases) ? entry.legacyAliases : []) {
      if (typeof alias === 'string' && alias.trim()) {
        allowed.add(alias);
        aliases[alias] = entry.key;
      }
    }
  }
  return { allowed, exportable, aliases, entries: manifest };
}

function findMatching(source, openIndex, openChar, closeChar) {
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === openChar) {
      depth += 1;
    } else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  throw new Error(`could not find closing ${closeChar} for ${openChar} at offset ${openIndex}`);
}

function extractNamedFunctionBody(source, functionName) {
  const signature = `function ${functionName}`;
  const signatureIndex = source.indexOf(signature);
  if (signatureIndex === -1) {
    throw new Error(`missing ${signature}`);
  }
  const openBrace = source.indexOf('{', signatureIndex);
  if (openBrace === -1) {
    throw new Error(`missing body for ${signature}`);
  }
  const closeBrace = findMatching(source, openBrace, '{', '}');
  return source.slice(openBrace + 1, closeBrace);
}

function extractNewSetStringEntries(source, constantName) {
  const declaration = `const ${constantName}`;
  const declarationIndex = source.indexOf(declaration);
  if (declarationIndex === -1) {
    throw new Error(`missing ${constantName} declaration`);
  }

  const newSetIndex = source.indexOf('new Set', declarationIndex);
  if (newSetIndex === -1) {
    throw new Error(`missing new Set initializer for ${constantName}`);
  }

  const openParen = source.indexOf('(', newSetIndex);
  const closeParen = findMatching(source, openParen, '(', ')');
  const initializer = source.slice(openParen + 1, closeParen);
  const openBracket = initializer.indexOf('[');
  if (openBracket === -1) {
    throw new Error(`missing array initializer for ${constantName}`);
  }
  const closeBracket = findMatching(initializer, openBracket, '[', ']');
  const ids = extractStringLiterals(initializer.slice(openBracket + 1, closeBracket));
  if (ids.length === 0) {
    throw new Error(`${constantName} static parse found zero ids`);
  }
  return ids;
}

function extractStringLiterals(source) {
  const values = [];
  const literalPattern = /(['"])((?:\\.|(?!\1).)*)\1/g;
  let match;
  while ((match = literalPattern.exec(source)) !== null) {
    values.push(match[2].replace(/\\(['"\\])/g, '$1'));
  }
  return values;
}

function extractObjectStringMap(source, constantName) {
  const declaration = `const ${constantName}`;
  const declarationIndex = source.indexOf(declaration);
  if (declarationIndex === -1) {
    throw new Error(`missing ${constantName} declaration`);
  }
  const openBrace = source.indexOf('{', declarationIndex);
  if (openBrace === -1) {
    throw new Error(`missing object initializer for ${constantName}`);
  }
  const closeBrace = findMatching(source, openBrace, '{', '}');
  const objectLiteral = source.slice(openBrace, closeBrace + 1);
  const parsed = vm.runInNewContext(`(${objectLiteral})`, Object.create(null));
  const result = {};
  for (const [key, value] of Object.entries(parsed || {})) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`${constantName}.${key} is not a non-empty string`);
    }
    result[key] = value;
  }
  return result;
}

function extractConstantArray(source, constantName) {
  const declaration = `const ${constantName}`;
  const declarationIndex = source.indexOf(declaration);
  if (declarationIndex === -1) {
    throw new Error(`missing ${constantName} declaration`);
  }
  const openBracket = source.indexOf('[', declarationIndex);
  if (openBracket === -1) {
    throw new Error(`missing array initializer for ${constantName}`);
  }
  const closeBracket = findMatching(source, openBracket, '[', ']');
  const parsed = vm.runInNewContext(source.slice(openBracket, closeBracket + 1), Object.create(null));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${constantName} static parse found zero entries`);
  }
  return parsed;
}

function extractChannelsForCardPropertyValues(source, propertyName) {
  const body = extractNamedFunctionBody(source, 'channelsForCard');
  const values = [];
  const propertyPattern = new RegExp(`\\b${propertyName}\\s*:\\s*(['"])((?:\\\\.|(?!\\1).)*)\\1`, 'g');
  let match;
  while ((match = propertyPattern.exec(body)) !== null) {
    values.push(match[2].replace(/\\(['"\\])/g, '$1'));
  }
  if (values.length === 0) {
    throw new Error(`channelsForCard static parse found zero ${propertyName} values`);
  }
  return values;
}

function assertCovered(ids, allowed, label) {
  const missing = Array.from(new Set(ids.filter((id) => !allowed.has(id)))).sort();
  if (missing.length > 0) {
    throw new Error(`${label} coverage missing from channels manifest keys/legacyAliases: ${missing.join(', ')}`);
  } else {
    console.log(`OK ${label} coverage is covered by channels manifest keys/legacyAliases (${new Set(ids).size} ids)`);
  }
}

function assertSameSet(actualIds, expectedSet, label) {
  const actual = Array.from(new Set(actualIds)).sort();
  const expected = Array.from(expectedSet).sort();
  if (actual.join('\n') !== expected.join('\n')) {
    const missing = expected.filter((id) => !actual.includes(id));
    const extra = actual.filter((id) => !expected.includes(id));
    throw new Error(`${label} mismatch; missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`);
  }
  console.log(`OK ${label} exactly matches channels manifest (${actual.length} ids)`);
}

function assertSameMap(actual, expected, label) {
  const actualEntries = Object.entries(actual).sort(([left], [right]) => left.localeCompare(right));
  const expectedEntries = Object.entries(expected).sort(([left], [right]) => left.localeCompare(right));
  if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
    throw new Error(`${label} mismatch; actual=${JSON.stringify(actualEntries)} expected=${JSON.stringify(expectedEntries)}`);
  }
  console.log(`OK ${label} exactly matches channels manifest (${actualEntries.length} aliases)`);
}

function normalizeAnalysisChannel(entry) {
  return {
    key: entry.key,
    unit: entry.unit ?? null,
    label: entry.label,
    cardType: entry.cardType,
    edgeField: entry.edgeField ?? null,
    exportable: entry.exportable === true,
    deprecated: entry.deprecated === true,
  };
}

function expectedAnalysisChannels(manifestEntries) {
  const analysisCardTypes = new Set(['soil', 'environment', 'dendro']);
  return manifestEntries
    .filter((entry) =>
      entry.exportable === true &&
      entry.deprecated !== true &&
      analysisCardTypes.has(entry.cardType)
    )
    .map(normalizeAnalysisChannel);
}

function assertSameAnalysisChannels(actualEntries, expectedEntries, label) {
  const actual = actualEntries.map(normalizeAnalysisChannel);
  const expected = expectedEntries.map(normalizeAnalysisChannel);
  const actualKeys = actual.map((entry) => entry.key).sort();
  const expectedKeys = expected.map((entry) => entry.key).sort();
  if (actualKeys.join('\n') !== expectedKeys.join('\n')) {
    const missing = expectedKeys.filter((id) => !actualKeys.includes(id));
    const extra = actualKeys.filter((id) => !expectedKeys.includes(id));
    throw new Error(`${label} key mismatch; missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`);
  }
  for (const expectedEntry of expected) {
    const actualEntry = actual.find((entry) => entry.key === expectedEntry.key);
    if (JSON.stringify(actualEntry) !== JSON.stringify(expectedEntry)) {
      throw new Error(`${label} metadata mismatch for ${expectedEntry.key}; actual=${JSON.stringify(actualEntry)} expected=${JSON.stringify(expectedEntry)}`);
    }
  }
  console.log(`OK ${label} exactly matches active analysis channels manifest metadata (${actual.length} channels)`);
}

try {
  const manifest = loadManifestContract();
  for (const helperPath of helperPaths) {
    const helperSource = readText(helperPath);
    const helperLabel = path.relative(repoRoot, helperPath);
    const analysisPath = path.join(path.dirname(helperPath), 'analysis.js');
    const analysisSource = readText(analysisPath);
    const analysisLabel = path.relative(repoRoot, analysisPath);

    assertCovered(
      extractChannelsForCardPropertyValues(helperSource, 'id'),
      manifest.allowed,
      `${helperLabel} channelsForCard id`
    );
    assertCovered(
      extractChannelsForCardPropertyValues(helperSource, 'field'),
      manifest.allowed,
      `${helperLabel} channelsForCard field`
    );
    assertCovered(
      extractNewSetStringEntries(helperSource, 'ALLOWED_DEVICE_DATA_CHANNELS'),
      manifest.allowed,
      `${helperLabel} ALLOWED_DEVICE_DATA_CHANNELS`
    );
    assertSameSet(
      extractNewSetStringEntries(helperSource, 'VALID_EXPORT_CHANNEL_KEYS'),
      manifest.exportable,
      `${helperLabel} VALID_EXPORT_CHANNEL_KEYS`
    );
    assertSameMap(
      extractObjectStringMap(helperSource, 'LEGACY_CHANNEL_ALIASES'),
      manifest.aliases,
      `${helperLabel} LEGACY_CHANNEL_ALIASES`
    );
    assertSameAnalysisChannels(
      extractConstantArray(analysisSource, 'CHANNELS'),
      expectedAnalysisChannels(manifest.entries),
      `${analysisLabel} CHANNELS`
    );
  }

  console.log('Channel manifest parity verification passed');
} catch (error) {
  console.error(`FAIL: ${error && error.message ? error.message : error}`);
  process.exitCode = 1;
}
