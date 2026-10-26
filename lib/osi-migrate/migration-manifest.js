'use strict';
const { TextDecoder } = require('node:util');
const NAME_RE = /^([0-9]{4})__([a-z0-9_]+)\.sql$/;
function corpusError(message) {
  const e = new Error(`migration corpus: ${message}`);
  e.code = 'ERR_MIGRATION_CORPUS';
  return e;
}
function migrationName(name) {
  const m = typeof name === 'string' && NAME_RE.exec(name);
  if (!m || m[0] !== name) throw corpusError(`bad migration filename: ${JSON.stringify(name)}`);
  return { version: Number(m[1]), slug: m[2] };
}
function parseManifest(raw) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw); }
  catch (e) { throw corpusError(`invalid manifest UTF-8: ${e.message}`); }
  let i = 0;
  const white = () => { while (i < text.length && /[\t\n\r ]/.test(text[i])) i++; };
  const expect = (ch) => { white(); if (text[i++] !== ch) throw corpusError(`expected ${ch} in CHECKSUMS.json`); };
  const string = () => {
    white();
    if (text[i] !== '"') throw corpusError('manifest keys and hashes must be strings');
    const start = i++;
    while (i < text.length) {
      const ch = text[i++];
      if (ch === '\\') { i++; continue; }
      if (ch === '"') {
        try { return JSON.parse(text.slice(start, i)); }
        catch (e) { throw corpusError(`invalid JSON string: ${e.message}`); }
      }
    }
    throw corpusError('unterminated JSON string');
  };
  expect('{'); white();
  if (text[i] === '}') throw corpusError('empty manifest');
  const names = new Set(), versions = new Set(), entries = [];
  while (true) {
    const name = string();
    if (names.has(name)) throw corpusError(`duplicate manifest key: ${name}`);
    names.add(name);
    const { version, slug } = migrationName(name);
    if (versions.has(version)) throw corpusError(`duplicate migration version: ${version}`);
    versions.add(version);
    expect(':');
    const checksum = string();
    if (checksum.length !== 64 || !/^[0-9a-f]+$/.test(checksum)) throw corpusError(`malformed SHA-256 for ${name}`);
    entries.push(Object.freeze({ name, version, slug, checksum }));
    white();
    if (text[i] === '}') { i++; break; }
    expect(',');
  }
  white();
  if (i !== text.length) throw corpusError('trailing manifest input');
  return Object.freeze(entries.sort((a, b) => a.version - b.version));
}
module.exports = { parseManifest, migrationName, corpusError };
