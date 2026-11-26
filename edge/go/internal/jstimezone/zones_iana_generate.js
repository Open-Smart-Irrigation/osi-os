'use strict';
// Run with Node 20.18.3. Pass another tzdata.zi path to refresh the IANA list.
const fs = require('node:fs');
const path = require('node:path');

if (process.versions.node !== '20.18.3' || process.versions.icu !== '75.1' || process.versions.tz !== '2024b') {
  throw new Error('use the Node 20.18.3 oracle with ICU 75.1 and tzdata 2024b');
}

const iana = fs.readFileSync(process.argv[2] || '/usr/share/zoneinfo/tzdata.zi', 'utf8');
const names = new Set(Intl.supportedValuesOf('timeZone'));
for (const line of iana.split('\n')) {
  const [kind, first, second] = line.split(/\s+/);
  if (kind === 'Z' || kind === 'Zone') names.add(first);
  if (kind === 'L' || kind === 'Link') names.add(second);
}
// ICU 75's time-zone enumeration contains these names outside the IANA list.
for (const name of [
  'ACT', 'AET', 'AGT', 'ART', 'AST', 'BET', 'BST', 'CAT', 'CNT', 'CST', 'CTT',
  'Canada/East-Saskatchewan', 'EAT', 'ECT', 'IET', 'IST', 'JST', 'MIT', 'NET',
  'NST', 'PLT', 'PNT', 'PRT', 'PST', 'SST', 'SystemV/AST4', 'SystemV/AST4ADT',
  'SystemV/CST6', 'SystemV/CST6CDT', 'SystemV/EST5', 'SystemV/EST5EDT',
  'SystemV/HST10', 'SystemV/MST7', 'SystemV/MST7MDT', 'SystemV/PST8',
  'SystemV/PST8PDT', 'SystemV/YST9', 'SystemV/YST9YDT', 'US/Pacific-New', 'VST',
]) names.add(name);
for (const name of [
  'Etc/Unknown', 'Local', 'local', 'Not/AZone', 'europe/Kiev', '',
  ' Europe/Zurich ', '\uFEFFEurope/Zurich\uFEFF', '\uFEFF',
  '+14:00', '-03:30', '+0500', '+05', '-00:00', '+24:00', 'UTC+05:30', 'Z',
]) names.add(name);
for (const name of names) names.add(name.toLowerCase());

function canonical(name) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone; }
  catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

// A null means rejection. The third column applies the settings route's String.trim().
const cases = [...names].sort().map((name) => JSON.stringify([name, canonical(name), canonical(name.trim())]));
const source = JSON.stringify({
  node: process.versions.node, icu: process.versions.icu, tz: process.versions.tz,
  iana: iana.split('\n')[0].replace('# version ', ''),
});
fs.writeFileSync(path.join(__dirname, 'zones_iana.vectors.json'),
  '{"source":' + source + ',"cases":[\n' + cases.join(',\n') + '\n]}\n');
