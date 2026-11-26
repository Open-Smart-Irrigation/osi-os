#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

if (process.versions.node !== '20.18.3' || !process.versions.v8.startsWith('11.3.')) {
  throw new Error('Generate Date vectors with the pinned Node 20.18.3 oracle');
}

const strings = new Set([
  '', ' ', 'null', 'undefined', '1970-01-01', '1970-01', '1970', '0000', '0001',
  '+000000-01-01', '-000000-01-01', '-000000-01-01T00:00Z',
  '+010000-01-01T00:00:00Z', '-000001-01-01T00:00:00Z',
  '9999-12-31T23:59:59-01:00', '0000-01-01T00:00:00+01:00',
  '+275760-09-13T00:00:00.000Z', '+275760-09-13T00:00:00.001Z',
  '-271821-04-20T00:00:00.000Z', '-271821-04-19T23:59:59.999Z',
  '+275760-09-13T00:00', '-271821-04-20T00:00',
  '1894-06-01T00:00', '1894-06-01 00:00', '1900-01-01T00:00',
  '2024-03-31T01:59:59', '2024-03-31T02:00', '2024-03-31T02:30',
  '2024-03-31 02:59:59', '2024-03-31T03:00', '2024-10-27T02:30',
  '2024-10-27 02:30:59', '2024-10-27T02:30+0100', '2024-10-27T02:30+0200',
  '2026/11/23 00:00:00 GMT', '2026/11/23 00:00:00',
  'Mon, 20 Jul 2026 23:30:00 PST', '20 Jul 2026 (comment) 23:30:00',
  'Wed Dec 31 1969 16:00:00 GMT-0800 (Pacific Standard Time)',
  'January 1', 'Jan 31', '0 Jan', '32 Jan', 'Sep 2 2001 99',
  'Today, 2026/11/23', 'Today2026/11/23', '2026/11/23 today',
  '2026-11-23 (one (two) three)', '(one) 2026/11/23', '2026/11/23 (one',
  '2026/11/23 )', '2026-11-23\x00junk', '2026-11-23T21:20Z\x00junk',
  '2026-11-23 11::20', '2026-11-23 11:.20', '2026-11-23 11:20.25',
  '2026-11-23 00:00:00+01:', '2026-11-23 00:00:00+01:60',
  '2026-11-23 00:00:00+00000000001:30', '2026-11-23 00:00:00+999999999:00',
  '2026-11-23 00:00:00+0000000000000:30', '2026-11-23 00:00:00+01:30:20',
]);

for (const day of ['2026', '2026-11', '2026-11-23', '2025-02-29', '2024-02-31',
  '2026-13-01', '2026-12-32', '2026-00-12', '2026-1-2', '0001-01-01', '-000001-03-01']) {
  for (const time of ['', 'T21:20Z', 't21:20z', 'T21:20', 'T21:20:00.123456789+0230',
    'T21:20:00.000000000123456789Z', 'T24:00:00.0000000001Z',
    'T24:00:00.000Z', ' 24:00:00.0000000001', 'T24:00:01Z', 'T23:60Z',
    'T23:59:60Z', 'T23:59:59.Z', 'T00:00+23:59', 'T00:00+24:00',
    'T00:00+12:60', 'T00:00+1:00', 'T00:00+02', ' T00:00Z', ' 00:00Z',
    ' 00:00:00 +02:00', ' 00:00:00 +0230', ' 00:00:00 -7', ' 00:00:00 UTC']) {
    strings.add(day + time);
  }
}

for (const day of ['2026/11/23', '11/23/2026', '2026.11.23', 'November 23, 2026', '23-November-2026']) {
  for (const clock of ['', '0:00', '3:22:10.01 pm', '12:22:10 AM', '24:00', '6:15:00.1234']) {
    for (const tz of ['', 'Z', 'UTC', 'GMT+02:00', 'CET', 'UT', 'PST', 'EDT', '-0815']) {
      strings.add([day, clock, tz].filter(Boolean).join(' '));
    }
  }
}

for (const text of ['0', '1', '12', '13', '31', '32', '49', '50', '99', '100', '000', '00001',
  '1/2', '01/02/03', '2026-11-23', '2026-11-23T06:35Z', '2026-11-23 06:35',
  '2026-11-23 06:35z', 'Mon, 23 Nov 2026 06:35:00 GMT', '2026/11/23']) {
  strings.add(text);
  for (const space of [' ', '\t', '\r\n', '\u00a0', '\u2028', '\u2029', '\u2003', '\ufeff', '\u0085']) {
    strings.add(space + text + space);
    strings.add(text + space + 'GMT');
  }
}

const dates = [...strings].map(input => {
  const expect = {};
  for (const timezone of ['UTC', 'Europe/Zurich']) {
    process.env.TZ = timezone;
    const milliseconds = Date.parse(input);
    expect[timezone] = Number.isFinite(milliseconds) ? [milliseconds, new Date(milliseconds).toISOString()] : null;
  }
  return { input, expect };
});

const epoch = [
  -8640000000000001, -8640000000000000, -62198755200000, -62167219200000, -62135596800000,
  -1001, -1.9, -0.5, 0, 0.5, 1.9, 999, 253402300799999, 253402300800000,
  8640000000000000, 8640000000000001,
].map(input => {
  const date = new Date(input);
  return { input, expect: Number.isFinite(date.getTime()) ? date.toISOString() : null };
});

const pinned = JSON.stringify({ node: process.versions.node, v8: process.versions.v8 });
const rows = (cases) => cases.map(value => '  ' + JSON.stringify(value)).join(',\n');
const vectors = pinned.slice(0, -1) + ',"dates":[\n' + rows(dates) + '\n],"epoch":[\n' + rows(epoch) + '\n]}\n';
fs.writeFileSync(path.join(__dirname, 'js-date.vectors.json'), vectors);
