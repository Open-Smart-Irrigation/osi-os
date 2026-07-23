#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const canonicalPath = path.join(
  root,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
);
const mirrorPath = path.join(
  root,
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'
);
const flows = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));
const node = flows.find((candidate) => candidate.id === 'journal-api-router-fn');
if (!node) throw new Error('journal-api-router-fn not found');

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`missing ${label} anchor`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`ambiguous ${label} anchor`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

let source = node.func;
source = replaceOnce(
  source,
  `const dbLoad = osiLib.require('osi-db-helper');
const journalLoad = osiLib.require('osi-journal');
if (!dbLoad.ok || !journalLoad.ok) {
  const detail = [dbLoad, journalLoad]`,
  `const dbLoad = osiLib.require('osi-db-helper');
const journalLoad = osiLib.require('osi-journal');
const scopedOn = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';
const scopeLoad = scopedOn ? osiLib.require('scope') : { ok: true, value: null };
if (!dbLoad.ok || !journalLoad.ok || !scopeLoad.ok) {
  const detail = [dbLoad, journalLoad, scopeLoad]`,
  'helper loads'
);
source = replaceOnce(
  source,
  `  msg: msg,
  Database: osiDb.Database,
  environment: {`,
  `  msg: msg,
  Database: osiDb.Database,
  scope: scopeLoad.value,
  scopedMode: scopedOn,
  environment: {`,
  'handler options'
);
node.func = source;

const serialized = JSON.stringify(flows, null, 2) + '\n';
fs.writeFileSync(canonicalPath, serialized);
fs.writeFileSync(mirrorPath, serialized);
