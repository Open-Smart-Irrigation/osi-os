'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(repoRoot, 'web', 'react-gui', 'src', 'channels', 'channels.json');
const helperPath = path.join(
  repoRoot,
  'conf',
  'full_raspberrypi_bcm27xx_bcm2712',
  'files',
  'usr',
  'share',
  'node-red',
  'osi-history-helper',
  'index.js'
);

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function loadManifestKeysAndAliases() {
  const manifest = JSON.parse(readText(manifestPath));
  if (!Array.isArray(manifest)) {
    throw new Error(`expected manifest array in ${path.relative(repoRoot, manifestPath)}`);
  }

  const allowed = new Set();
  for (const entry of manifest) {
    if (!entry || typeof entry.key !== 'string' || !entry.key.trim()) {
      throw new Error('manifest entry is missing a non-empty key');
    }
    allowed.add(entry.key);
    for (const alias of Array.isArray(entry.legacyAliases) ? entry.legacyAliases : []) {
      if (typeof alias === 'string' && alias.trim()) {
        allowed.add(alias);
      }
    }
  }
  return allowed;
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

try {
  const allowedManifestIds = loadManifestKeysAndAliases();
  const helperSource = readText(helperPath);

  assertCovered(
    extractChannelsForCardPropertyValues(helperSource, 'id'),
    allowedManifestIds,
    'channelsForCard id'
  );
  assertCovered(
    extractChannelsForCardPropertyValues(helperSource, 'field'),
    allowedManifestIds,
    'channelsForCard field'
  );
  assertCovered(
    extractNewSetStringEntries(helperSource, 'ALLOWED_DEVICE_DATA_CHANNELS'),
    allowedManifestIds,
    'ALLOWED_DEVICE_DATA_CHANNELS'
  );

  console.log('Channel manifest parity verification passed');
} catch (error) {
  console.error(`FAIL: ${error && error.message ? error.message : error}`);
  process.exitCode = 1;
}
