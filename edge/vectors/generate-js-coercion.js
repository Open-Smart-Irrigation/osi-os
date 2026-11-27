#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

if (process.versions.node !== '20.18.3' || !process.versions.v8.startsWith('11.3.')) {
  throw new Error('Generate coercion vectors with Node 20.18.3');
}
process.env.TZ = 'UTC';

const inputs = [
  'null', 'true', 'false', '-0', '0', '1', '-1.9', '1.9', '1e400', '-1e400',
  '1e-400', '-1e-400', '1e21', '1e-7', '2147483647', '2147483648',
  '4294967295', '4294967296', '-4294967297', '9007199254740997',
  '8640000000000000', '8640000000000001', '-8640000000000000', '-8640000000000001',
  '{}', '{"x":{"toString":0}}', '{"__proto__":{"toString":0}}',
  '{"valueOf":0}', '{"valueOf":{"toString":0}}', '{"valueOf":[1]}',
  '{"toString":null}', '{"toString":false}', '{"toString":"x","valueOf":7}',
  '{"toString":[]}', '{"toString":{"valueOf":8}}', '{"toString":0,"toString":1}',
  '[]', '[null]', '[false]', '[1]', '[1,2]', '[[],[0],null,["x",null]]',
  '[{"valueOf":0}]', '[{}]', '[null,[{"toString":0}]]', '[{"x":{"toString":0}}]',
  '["\\ud800","\\udc00",null]',
  ...[
    '', '  ', '\u00a0\ufeff', '\u0085', '\u0000', 'NaN', 'Infinity', '-Infinity',
    '+Infinity', 'infinity', '+', '-', '00', '012', '-0', '.1', '3.e2', '1_000',
    '5e-324', '1e400', '１２', '0xf', '-0xf', '0x', '0x1p3', '0X1A',
    '0b101', '0B11', '0b2', '0o77', '0O7', '0o8',
    '0x10000000000000000', '0x20000000000001', '0x10000000000000801',
    '0x' + 'f'.repeat(300), '0x' + 'f'.repeat(80) + 'z',
    '0b' + '1'.repeat(65), '0o' + '7'.repeat(23),
    '2026-11-23', '2026-11-23T02:30:00+02:00', '11/23/2026', '2026/11/23',
    '2026-11-23 04:30', '2026-13-01', '+010000-01-01T00:00:00Z',
    '\ud800', 'a\udc00z', '😀',
  ].map(s => JSON.stringify(s)),
];
inputs.push('["2026-11-23"]', '[[["2026-11-23"]]]', '["2026","11","23"]');

const ops = {
  string: v => String(v),
  number: v => Object.is(Number(v), -0) ? '-0' : String(Number(v)),
  int32: v => v | 0,
  shift: v => v >> 3,
  date: v => {
    const date = new Date(v);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  },
  template: v => `${v}`,
  concat: v => v + '',
};
const vectors = inputs.map(input => {
  const v = JSON.parse(input);
  const expect = Object.fromEntries(Object.entries(ops).map(([name, op]) => {
    try { return [name, { value: op(v) }]; }
    catch (err) { return [name, { error: { name: err.name, message: err.message } }]; }
  }));
  return { input, expect };
});

const casing = [
  '', 'OpenSmart Irrigation', 'Straße', 'aﬀﬁﬂﬃﬄﬅﬆ', 'ŉ İ ı ẞ', 'K Å ſ',
  'ΐ ΰ ῒ ῗ ᾰ ᾲ ῼ', 'ΟΣ ΟΣΑ ΑΣ ΑΣ. ΑΣ.A ΑΣ:A ΑΣ\u0301',
  'Σ ΣΣ σς', 'AΣ' + '\u0345'.repeat(32) + 'A', 'AΣ' + '\u0301'.repeat(80) + 'A',
  '𐐀𐐨 Ⴀⴀ Აა', 'ẛ\u0307', 'ᾀᾈᾜ', 'ꞌꞍꞎ', '\u019b\u0264\u1c89\ua7cb', '😀 ß', '\ud800AΣ\udc00',
].map(input => ({ input, upper: input.toUpperCase(), lower: input.toLowerCase() }));

const utf8 = [
  '5af09f98', '4c61f09f9821e28221', '555443f09f98', 'eda080', 'f4908080',
  'f0808080', 'f09ff09f98', 'e282f09f98', '80c0af', 'e282ac', 'efbbbf78',
].map(input => ({ input, expect: Buffer.from(input, 'hex').toString() }));

// Pin case properties and mappings to the same Unicode version as the oracle.
const mappings = { upper: [], lower: [] };
const properties = { cased: [], caseIgnorable: [] };
for (let code = 0; code <= 0x10ffff; code++) {
  const char = String.fromCodePoint(code);
  if (/\p{Cased}/u.test(char)) properties.cased.push(code);
  if (/\p{Case_Ignorable}/u.test(char)) properties.caseIgnorable.push(code);
  for (const [name, mapped] of [['upper', char.toUpperCase()], ['lower', char.toLowerCase()]]) {
    if (mapped !== char) mappings[name].push([code, mapped]);
  }
}
const mappedDigest = {};
for (const [name, values] of Object.entries(mappings)) {
  const hash = createHash('sha256');
  for (const [code, mapped] of values) hash.update(code + ':' + mapped + '\n');
  mappedDigest[name] = hash.digest('hex');
}

const metadata = JSON.stringify({ node: process.versions.node, v8: process.versions.v8, mappedDigest });
const rows = cases => cases.map(value => '  ' + JSON.stringify(value)).join(',\n');
const output = metadata.slice(0, -1) +
  ',"vectors":[\n' + rows(vectors) + '\n],"casing":[\n' + rows(casing) +
  '\n],"utf8":[\n' + rows(utf8) + '\n]}\n';
fs.writeFileSync(path.join(__dirname, 'js-coercion.vectors.json'), output);

const hex = n => '0x' + n.toString(16);
function goRows(entries, columns) {
  const lines = [];
  for (let i = 0; i < entries.length; i += columns) {
    lines.push('\t' + entries.slice(i, i + columns).join(', ') + ',');
  }
  return lines.join('\n');
}

function emitMappings(name, entries) {
  const spans = [], expansions = [];
  const delta = ([code, mapping]) => [...mapping].length === 1 ?
    mapping.codePointAt(0) - code : null;
  for (let i = 0; i < entries.length;) {
    const [start, mapping] = entries[i];
    const shift = delta(entries[i]);
    if (shift === null) {
      expansions.push([hex(start) + ':', JSON.stringify(mapping)]);
      i++;
      continue;
    }
    // Runs with stride 2 are common among adjacent uppercase/lowercase pairs.
    let end = start, stride = 1;
    if (i + 1 < entries.length && delta(entries[i + 1]) === shift) {
      stride = Math.min(2, entries[i + 1][0] - start);
    }
    while (++i < entries.length && entries[i][0] === end + stride && delta(entries[i]) === shift) {
      end = entries[i][0];
    }
    spans.push('{' + [hex(start), hex(end), shift, stride].join(', ') + '}');
  }
  const width = Math.max(0, ...expansions.map(([key]) => key.length)) + 1;
  const expansionLines = expansions.map(([key, value]) => key.padEnd(width) + value);
  return 'var ' + name + 'Spans = []caseSpan{\n' + goRows(spans, 4) + '\n}\n\n' +
    'var ' + name + 'Expansions = map[rune]string{\n' + goRows(expansionLines, 1) + '\n}\n';
}

function emitProperty(name, codes) {
  const spans = [];
  for (let i = 0; i < codes.length;) {
    const start = codes[i];
    let end = start;
    while (++i < codes.length && codes[i] === end + 1) end = codes[i];
    spans.push('{' + hex(start) + ', ' + hex(end) + '}');
  }
  return 'var ' + name + 'Ranges = []runeRange{\n' + goRows(spans, 4) + '\n}\n';
}

const tables = '// Code generated by edge/vectors/generate-js-coercion.js. DO NOT EDIT.\n' +
  '// Node ' + process.versions.node + ', Unicode ' + process.versions.unicode + '.\n\npackage jsvalue\n\n' +
  [...Object.entries(mappings).map(([name, data]) => emitMappings(name, data)),
   ...Object.entries(properties).map(([name, data]) => emitProperty(name, data))].join('\n');
fs.writeFileSync(path.join(__dirname, '../go/internal/jsvalue/case_tables.go'), tables);
