#!/usr/bin/env node
// Asserts audit-pi-db.js REQUIRED_TABLES uses correct table names.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.resolve(__dirname, 'audit-pi-db.js'), 'utf8');

const match = src.match(/const REQUIRED_TABLES\s*=\s*(\{[\s\S]*?\n\});/);
if (!match) {
    console.error('FAIL: could not find REQUIRED_TABLES in audit-pi-db.js');
    process.exit(1);
}

const tables = new Function(`return ${match[1]}`)();

const MUST_HAVE = ['irrigation_zones', 'irrigation_schedules'];
const MUST_NOT_HAVE = ['zones', 'schedules'];

let ok = true;
for (const name of MUST_HAVE) {
    if (!tables[name]) {
        console.error(`FAIL M6: REQUIRED_TABLES missing correct name '${name}'`);
        ok = false;
    } else {
        console.log(`OK  M6: '${name}' present in REQUIRED_TABLES`);
    }
}
for (const name of MUST_NOT_HAVE) {
    if (tables[name]) {
        console.error(`FAIL M6: REQUIRED_TABLES has wrong short name '${name}'`);
        ok = false;
    } else {
        console.log(`OK  M6: wrong name '${name}' not present`);
    }
}

if (!ok) process.exit(1);
console.log('PASS: M6 audit table names are correct');
